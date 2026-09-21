// The app's one long-lived object: who we are paired with, what we know,
// and the stream that keeps it current.
//
// The parsing and folding live in CompanionCore. What lives here is the
// app composition around the testable seed coordinator and stream lifecycle.
// A phone loses its connection constantly: it locks, it
// backgrounds, it moves between wifi and cellular. So the stream is torn
// down deliberately when the app leaves the screen, and on the way back the
// server is asked what was missed rather than being asked for everything.
import Foundation
import OSLog
import SwiftUI
import CompanionCore
import UserNotifications
import UIKit

/// Stream lifecycle, in Console.app and the Xcode console. A companion that
/// is silently not connected looks exactly like one with nothing to say, so
/// the transitions are worth being able to read.
private let log = Logger(subsystem: "com.muster.companion", category: "stream")

@MainActor
final class Session: ObservableObject {
    enum Status: Equatable {
        case unpaired
        case connecting
        case live
        /// The token stopped working — revoked on the computer, most likely.
        case unauthorized
        case offline(String)
    }

    @Published private(set) var state = CompanionState() {
        didSet {
            stateRevision &+= 1
            seedCoordinator.reconcile()
            composerCoordinator.reconcile()
            approvalCoordinator.reconcile()
            publishFleetSnapshot()
        }
    }
    private var stateRevision: UInt64 = 0
    @Published private(set) var seedSessionId = UUID()
    @Published private(set) var seedActions: [SeedActionKey: SeedActionState] = [:]
    @Published private(set) var composerDrafts: [ComposerContext: ComposerDraft] = [:]
    @Published private(set) var approvalActions: [ApprovalActionKey: ApprovalActionState] = [:]
    @Published private(set) var connection: Connection?
    @Published private(set) var status: Status = .unpaired
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?
    /// One exact message the next opened chat should reveal.
    @Published private(set) var focusedMessageId: String?
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    /// A short-lived desktop handoff waiting for PairingView to present it.
    @Published private(set) var pairingInvite: PairingInvite?
    /// Whether the GAIA-style welcome has been dismissed. Backed by
    /// UserDefaults; flipped by the welcome's own buttons (or a pairing
    /// deep link, whose intent beats onboarding). RootView reads it to
    /// decide WelcomeView vs PairingView while unpaired. The owned UI
    /// tests pass -com.muster.companion.reset-welcome to start cold even
    /// on a simulator that has launched the app before.
    @Published var welcomeSeen: Bool = {
        if ProcessInfo.processInfo.arguments.contains("-com.muster.companion.reset-welcome") {
            UserDefaults.standard.removeObject(forKey: "onboardingWelcomeSeen.v1")
            return false
        }
        return UserDefaults.standard.bool(forKey: "onboardingWelcomeSeen.v1")
    }() {
        didSet { UserDefaults.standard.set(welcomeSeen, forKey: "onboardingWelcomeSeen.v1") }
    }
    /// A conversation a notification tap asked to open. It stays set until a
    /// roster can actually resolve it to a chat, because a cold launch from a
    /// banner reaches the roster before the stream has folded the bot — the
    /// first frame that carries it satisfies the request and clears it.
    @Published var pendingOpenThreadId: String?

    private var client: CompanionClient? {
        didSet {
            streamGeneration += 1
            streamTask?.cancel(); streamTask = nil
            seedSessionId = UUID()
            seedCoordinator.bind(sessionId: seedSessionId, transport: client)
            composerCoordinator.bind(sessionId: seedSessionId, transport: client)
            approvalViewLease = nil
            approvalCoordinator.bind(sessionId: seedSessionId, transport: client)
        }
    }
    private var pairingGeneration = 0
    private lazy var seedCoordinator: SeedActionCoordinator = SeedActionCoordinator(
        readState: { [weak self] in self?.state ?? CompanionState() },
        writeState: { [weak self] in self?.state = $0 },
        changed: { [weak self] in self?.seedActions = $0 },
        unauthorized: { [weak self] in self?.status = .unauthorized }
    )
    private lazy var composerCoordinator = ComposerCoordinator(
        readState: { [weak self] in self?.state ?? CompanionState() },
        changed: { [weak self] in self?.composerDrafts = $0 },
        unauthorized: { [weak self] in self?.status = .unauthorized }
    )
    private lazy var approvalCoordinator = ApprovalActionCoordinator(
        readState: { [weak self] in self?.state ?? CompanionState() },
        changed: { [weak self] in self?.approvalActions = $0 },
        unauthorized: { [weak self] in self?.status = .unauthorized }
    )
    private var approvalViewLease: ApprovalViewLease?
    private var streamTask: Task<Void, Never>?
    /// Identifies the task currently stored in `streamTask`. A cancelled task
    /// can finish after its replacement starts; its cleanup must not clear
    /// the replacement's handle.
    private var streamGeneration = 0
    private var reconnectDelay: UInt64 = 0
    /// How many computer panels are open. A count rather than a flag: the
    /// panel can be pushed twice in a navigation stack, and the last one to
    /// close is the one that should turn screens back off.
    private var screenWatchers = 0
    /// A saved connection exists, but its token could not be read yet. Keeps
    /// "the keychain is locked" from being mistaken for "not paired".
    private var restorePending = false

    private static let connectionKey = "companion.connection"

    // MARK: - Fleet snapshot (widget / Live Activity)

    /// Publish the mascot's external surfaces after every state change.
    /// Content-throttled: only a real change writes to the shared group.
    private func publishFleetSnapshot() {
        var isOffline = false
        if case .offline = status { isOffline = true }
        if case .unpaired = status { isOffline = true }
        let mood = FleetMood.from(
            isOffline: isOffline,
            approvals: state.pendingApprovals.count,
            working: state.bots.filter { $0.busy == true }.count,
            unread: state.bots.filter(\.unread).count + state.rooms.filter(\.unread).count
        )
        let snapshot = fleetSnapshot(state: state, mood: mood)
        if let current = FleetSnapshotStore.read(),
           current.bots == snapshot.bots, current.moodState == snapshot.moodState {
            return
        }
        FleetSnapshotStore.publish(snapshot)
        FleetActivitySync.sync(snapshot)
    }

    // MARK: - Pairing

    init() {
        _ = NotificationCoordinator.shared
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-store-preview"),
           let url = Bundle.main.url(forResource: "StorePreview", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let fleet = try? JSONDecoder().decode(Fleet.self, from: data) {
            connection = Connection(name: "Preview Mac", host: "preview.tailnet.ts.net", port: 8810)
            state.hydrate(fleet)
            status = .live
            return
        }
#endif
        restore()
        // Wake the radio early so a handoff sent while the phone was closed
        // (application context) is readable by the time the watch asks.
        WatchHandoffBridge.shared.activateIfNeeded()
        Task { await refreshNotificationAuthorization() }
    }

    /// Rebuild the last connection at launch.
    ///
    /// Three outcomes, and keeping them apart is the whole point. No saved
    /// connection: stay unpaired. A saved connection whose token reads back:
    /// connect. A saved connection whose token cannot be read *yet* — the
    /// locked keychain before a phone's first unlock after reboot, which is
    /// when iOS is most likely to have launched us in the background — hold
    /// on to it and try again. Only the middle case is a real pairing, and
    /// only the first should ever send someone back to the pairing screen.
    private func restore() {
        restorePending = false
        guard let data = UserDefaults.standard.data(forKey: Self.connectionKey),
              let saved = try? JSONDecoder().decode(Connection.self, from: data)
        else { return }

        let stored: String?
        do {
            stored = try Keychain.token(for: saved.id)
        } catch {
            // Keep the connection and say why. `.offline` rather than
            // `.unpaired` matters: the latter is what puts PairingView on
            // screen, and asking for a new code is the one recovery that
            // costs a walk to the computer.
            connection = saved
            restorePending = true
            status = .offline(
                (error as? KeychainError)?.isLocked == true
                    ? "Unlock this phone to reach your computer."
                    : error.localizedDescription
            )
            return
        }
        guard let stored else { return } // no token: genuinely not paired

        connection = saved
        client = CompanionClient(connection: saved, token: stored)
        status = .connecting
    }

    /// Redeem a one-time pairing credential. On success the device token goes
    /// to the keychain and the connection to defaults — deliberately apart,
    /// so the thing that gets backed up is never the credential.
    func pair(with connection: Connection, credential: String, deviceName: String) async throws {
        pairingGeneration += 1
        let pairing = pairingGeneration
        let paired = try await CompanionClient.pair(
            connection: connection,
            credential: credential,
            deviceName: deviceName
        )
        guard pairing == pairingGeneration, !Task.isCancelled else { throw CancellationError() }
        // prefer the name the computer calls itself over the Bonjour label
        var stored = connection
        if !paired.serverName.isEmpty { stored.name = paired.serverName }

        try Keychain.save(paired.token, for: stored.id)
        UserDefaults.standard.set(try? JSONEncoder().encode(stored), forKey: Self.connectionKey)

        // The watch follows the phone: same computer, its own device token,
        // no six-digit dance on the wrist. Silent no-op without a paired
        // watch.
        WatchHandoffBridge.shared.pushPairing(connection: stored, token: paired.token)

        self.state = CompanionState()
        self.connection = stored
        self.client = CompanionClient(connection: stored, token: paired.token)
        // A fresh pairing settles any restore that was still waiting on the
        // keychain — the token is in hand, so there is nothing left to retry.
        restorePending = false
        connect()
    }

    func receivePairingURL(_ url: URL) {
        guard status == .unpaired else {
            actionError = "This phone is already paired. Unpair it in Settings before connecting it to another computer."
            return
        }
        guard let invite = PairingInvite.parse(url) else {
            actionError = "That pairing invitation is not valid. Start pairing again on your computer."
            return
        }
        pairingInvite = invite
    }

    func consumePairingInvite() {
        pairingInvite = nil
    }

    func signOut() {
        pairingGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        restorePending = false
        if let id = connection?.id { Keychain.remove(id) }
        UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        connection = nil
        client = nil
        state = CompanionState()
        NotificationCoordinator.shared.setBadge(0)
        status = .unpaired
        // The watch follows the phone off the computer too — a wrist that
        // kept the token would be a stale trust root.
        WatchHandoffBridge.shared.pushUnpair()
    }

    // MARK: - Lifecycle

    /// Called when the app comes to the front, and once at launch.
    func connect() {
        // A restore that found the keychain locked left `client` nil on
        // purpose. Coming to the front is the moment worth retrying on: the
        // app is on screen, so the phone is in someone's hand and unlocked.
        if client == nil, restorePending { restore() }
        guard let client, streamTask == nil else { return }
        reconnectDelay = 0
        streamGeneration += 1
        let generation = streamGeneration
        let identity = seedSessionId
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run(client: client, identity: identity, generation: generation)
            guard self.streamGeneration == generation else { return }
            self.streamTask = nil
        }
    }

    /// Pull-to-refresh: reopen the stream, and hold the control open until
    /// the connection has actually settled one way or the other.
    ///
    /// `connect()` returns the moment the task is spawned, so a `refreshable`
    /// that only calls it snaps the spinner shut before a single byte has
    /// arrived — the gesture reads as "nothing happened", on precisely the
    /// occasion it exists for. Waiting for `status` to leave `.connecting`
    /// makes the spinner mean what it appears to mean; the deadline is there
    /// so a network that never answers still gives the control back.
    func refresh() async {
        restartStream()
        connect()
        let deadline = Date().addingTimeInterval(10)
        while status == .connecting, !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    /// Ask the harness to include this bot's computer in the stream, for as
    /// long as something is showing it.
    ///
    /// This costs a reconnect, which is the right trade: the alternative is
    /// a base64 desktop capture arriving every few seconds for the whole
    /// session, including on cellular, whether or not anyone is looking.
    /// The reconnect resumes from the cursor, so nothing is missed.
    func watchScreen(of botId: String) {
        screenWatchers += 1
        if screenWatchers == 1 { restartStream() }
    }

    func stopWatchingScreen(of botId: String) {
        screenWatchers = max(0, screenWatchers - 1)
        if screenWatchers == 0 {
            state.clearScreen(botId)
            restartStream()
        }
    }

    /// Reopen the stream so its query string matches what we now want. The
    /// cursor survives, so this is a gap, not a reset.
    private func restartStream() {
        guard streamTask != nil else { return }
        seedCoordinator.connectionChanged(); approvalCoordinator.connectionChanged()
        streamTask?.cancel()
        streamTask = nil
        connect()
    }

    /// Called when the app leaves the screen. iOS will kill the connection
    /// anyway; dropping it deliberately means the cursor is written down at
    /// a known point instead of wherever the socket happened to die.
    func disconnect() {
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        seedCoordinator.connectionChanged(); approvalCoordinator.connectionChanged()
    }

    private func owns(_ identity: UUID) -> Bool { seedSessionId == identity && client != nil }

    private func currentStream(_ identity: UUID, _ generation: Int) -> Bool {
        owns(identity) && streamGeneration == generation && !Task.isCancelled
    }

    private func run(client: CompanionClient, identity: UUID, generation: Int) async {
        var firstConnection = true
        while !Task.isCancelled {
            guard currentStream(identity, generation) else { return }
            if !firstConnection { seedCoordinator.connectionChanged(); approvalCoordinator.connectionChanged() }
            firstConnection = false
            status = .connecting
            log.info("opening stream, cursor=\(self.state.cursor ?? "none", privacy: .public)")
            do {
                // The query is fixed when the connection opens, so changing
                // it means a new connection — `restartStream()` cancels this
                // task and starts another. Cancellation is the only exit;
                // breaking out here instead would fall through to the "the
                // harness went away" path and flash a lost-connection banner
                // on what is actually a deliberate reconnect.
                for try await frame in try client.events(since: state.cursor, screens: screenWatchers > 0) {
                    if !currentStream(identity, generation) { return }
                    reconnectDelay = 0

                    if case let .hello(cursor, resumed) = frame.frame {
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // false means the server could not replay the gap —
                        // the one case that costs a full hydrate. Commit the
                        // hello cursor only after that hydrate succeeds: if
                        // the request dies halfway through replay/hydration,
                        // reconnecting must still ask for the missing gap.
                        if !resumed {
                            try await hydrate(client: client, identity: identity, generation: generation)
                            guard currentStream(identity, generation) else { return }
                            state.resetCursor(cursor)
                        }
                        status = .live
                        continue
                    }
                    state.apply(frame)
                    if case let .notify(notification) = frame.frame {
                        NotificationCoordinator.shared.deliver(notification, sequence: frame.seq)
                    }
                    NotificationCoordinator.shared.setBadge(state.unreadCount)
                    state.advance(to: frame.seq)
                }
                guard currentStream(identity, generation) else { return }
                seedCoordinator.connectionChanged(); approvalCoordinator.connectionChanged()
                // the stream ended without an error — the harness went away
                log.notice("stream ended without an error")
                status = .offline("Lost the connection.")
            } catch let error as APIError where error.isUnauthorized {
                guard currentStream(identity, generation) else { return }
                seedCoordinator.connectionChanged(); approvalCoordinator.connectionChanged()
                log.error("stream refused: unauthorized")
                status = .unauthorized
                return
            } catch {
                // backgrounding cancels the stream on purpose; that is not a
                // failure to report, and it must not be retried
                if !currentStream(identity, generation) || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                seedCoordinator.connectionChanged(); approvalCoordinator.connectionChanged()
                log.error("stream failed: \(error.localizedDescription, privacy: .public)")
                status = .offline(error.localizedDescription)
            }

            if Task.isCancelled { return }
            // 1s, 2s, 4s… to 15s. A phone that woke on a network which is
            // not the laptop's should not hammer it.
            reconnectDelay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 15)
            try? await Task.sleep(nanoseconds: reconnectDelay * 1_000_000_000)
        }
    }

    private func hydrate(client: CompanionClient, identity: UUID, generation: Int) async throws {
        try await SeedSnapshotRefresh.hydrate(
            read: { try await client.fleet(messages: 50) },
            revision: { self.stateRevision },
            current: { self.currentStream(identity, generation) },
            apply: { fleet in
                log.info("hydrated \(fleet.bots.count, privacy: .public) bots, \(fleet.groups.count, privacy: .public) rooms")
                self.state.hydrate(fleet)
                NotificationCoordinator.shared.setBadge(self.state.unreadCount)
            }
        )
    }

    // MARK: - Actions

    func setForeground(_ active: Bool) {
        seedCoordinator.setForeground(active)
        composerCoordinator.setForeground(active)
        approvalCoordinator.setForeground(active)
    }

    func composerContext(for chat: Chat) -> ComposerContext {
        let kind: ComposerTarget.Kind
        switch chat { case .bot: kind = .bot; case .room: kind = .room }
        return ComposerContext(sessionId: seedSessionId, target: ComposerTarget(
            kind: kind, ownerId: chat.id, threadId: chat.threadId))
    }

    func viewComposer(_ context: ComposerContext) -> ComposerViewLease { composerCoordinator.enter(context) }
    func leaveComposer(_ lease: ComposerViewLease) { composerCoordinator.leave(lease) }
    func composerDraft(_ context: ComposerContext) -> ComposerDraft { composerCoordinator.draft(for: context) }
    func canEditComposer(_ context: ComposerContext, lease: ComposerViewLease?) -> Bool {
        composerCoordinator.canEdit(context, lease: lease)
    }
    func canSendComposer(_ context: ComposerContext, lease: ComposerViewLease?) -> Bool {
        composerCoordinator.canSend(context, lease: lease)
    }
    func editComposer(_ text: String, context: ComposerContext, lease: ComposerViewLease?) {
        composerCoordinator.edit(text, context: context, lease: lease)
    }
    func submitComposer(_ context: ComposerContext, lease: ComposerViewLease?) {
        composerCoordinator.submit(context, lease: lease)
    }

    func viewApprovalConversation(_ chat: Chat) -> ApprovalViewLease {
        let lease = approvalCoordinator.enter(composerContext(for: chat))
        approvalViewLease = lease
        return lease
    }

    func leaveApprovalConversation(_ lease: ApprovalViewLease) {
        approvalCoordinator.leave(lease)
        if approvalViewLease == lease { approvalViewLease = nil }
    }

    func approvalReference(chat: Chat, message: Message) -> ApprovalReference? {
        approvalCoordinator.reference(for: composerContext(for: chat), message: message)
    }

    func approvalState(chat: Chat, message: Message) -> ApprovalActionState? {
        guard let requestId = message.card?.requestId else { return nil }
        return approvalCoordinator.actionState(for: composerContext(for: chat), cardId: message.id, requestId: requestId)
    }

    func canSubmitApproval(_ reference: ApprovalReference) -> Bool {
        approvalCoordinator.canSubmit(reference, lease: approvalViewLease)
    }

    func submitApproval(_ reference: ApprovalReference, action: ApprovalAction) {
        approvalCoordinator.submit(reference, action: action, lease: approvalViewLease)
    }

    func viewSeedConversation(_ chat: Chat) -> UUID {
        // A room lease cannot authorize a direct-bot seed with the same IDs.
        switch chat {
        case let .bot(bot): return seedCoordinator.viewConversation(botId: bot.id, threadId: bot.threadId)
        case .room: return seedCoordinator.viewConversation(botId: "", threadId: "")
        }
    }

    func leaveSeedConversation(_ lease: UUID) { seedCoordinator.leaveConversation(lease) }

    func seedReference(chat: Chat, message: Message) -> SeedReference? {
        guard case let .bot(bot) = chat else { return nil }
        guard let reference = seedCoordinator.reference(botId: bot.id, threadId: bot.threadId, cardId: message.id),
              SeedCardContract.exactText(reference.signature, SeedCardContract.signature(message)) else { return nil }
        return reference
    }

    func actOnSeed(_ reference: SeedReference, action: SeedAction) async {
        await seedCoordinator.act(reference, action: action)
    }
    //
    // Each of these does the thing and lets the event stream deliver the
    // result. Nothing here writes to `state` optimistically: the harness is
    // the source of truth, and a phone that draws its own version of events
    // is a phone that disagrees with the laptop.

    func send(_ text: String, to chat: Chat) async {
        await perform {
            switch chat {
            case let .bot(bot): try await $0.send(text: text, toBot: bot.id)
            case let .room(room): try await $0.send(text: text, toRoom: room.id)
            }
        }
    }

    /// Make a new bot. The harness chooses its name, colour and greeting, so
    /// one made here is indistinguishable from one made on the desktop.
    ///
    /// Creating a bot does not broadcast — the desktop adds it optimistically
    /// too — so the new bot is folded in here rather than waited for. Return
    /// it so the caller can open it, which is the only reason anyone taps the
    /// button.
    @discardableResult
    func createBot() async -> Bot? {
        guard let client else { return nil }
        let identity = seedSessionId
        do {
            let bot = try await client.createBot()
            guard owns(identity), !Task.isCancelled else { return nil }
            state.apply(.bot(bot))
            return bot
        } catch {
            guard owns(identity), !Task.isCancelled else { return nil }
            actionError = error.localizedDescription
            return nil
        }
    }

    func interrupt(bot: Bot) async {
        await perform { try await $0.interrupt(botId: bot.id) }
    }

    /// Ask for one fresh cloud viewer URL. Unlike ordinary actions this
    /// returns the value to a browser sheet and never writes it to app state.
    func cloudDesktop(for bot: Bot) async throws -> URL {
        guard let client else { throw APIError.transport("This computer is offline.") }
        let identity = seedSessionId
        do {
            let url = try await client.cloudDesktop(botId: bot.id).url
            guard owns(identity), !Task.isCancelled else { throw CancellationError() }
            return url
        } catch let error as APIError where error.isUnauthorized {
            guard owns(identity), !Task.isCancelled else { throw CancellationError() }
            status = .unauthorized
            throw error
        }
    }

    func markRead(_ chat: Chat) async {
        await perform(quietly: true) {
            switch chat {
            case let .bot(bot): try await $0.markRead(botId: bot.id)
            case let .room(room): try await $0.markRead(roomId: room.id)
            }
        }
    }

    func loadOlder(threadId: String) async {
        guard let client, let oldest = state.transcript(forThread: threadId).first else { return }
        let identity = seedSessionId
        do {
            let page = try await client.messages(threadId: threadId, before: oldest.id, limit: 50)
            guard owns(identity), !Task.isCancelled else { return }
            state.prepend(page, toThread: threadId)
        } catch {
            guard owns(identity), !Task.isCancelled else { return }
            actionError = error.localizedDescription
        }
    }

    func image(threadId: String, messageId: String) async -> Data? {
        guard let client else { return nil }
        let identity = seedSessionId
        let data = try? await client.image(threadId: threadId, messageId: messageId)
        return owns(identity) && !Task.isCancelled ? data : nil
    }

    func search(_ query: String) async -> [SearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let client else { return [] }
        let identity = seedSessionId
        do {
            let results = try await client.search(trimmed)
            return owns(identity) && !Task.isCancelled ? results : []
        }
        catch {
            guard owns(identity), !Task.isCancelled else { return [] }
            actionError = error.localizedDescription
            return []
        }
    }

    /// Resolve a SQLite search hit into the live task/branch, load a page
    /// around it, and hand navigation the current chat record.
    func open(_ hit: SearchHit) async -> Chat? {
        guard let client else { return nil }
        let identity = seedSessionId
        do {
            if let botId = hit.botId, var bot = state.bot(botId) {
                if bot.threadId != hit.threadId {
                    bot = try await client.switchTask(botId: bot.id, threadId: hit.threadId)
                    guard owns(identity), !Task.isCancelled else { return nil }
                    state.apply(.bot(bot))
                }
                if !hit.onActivePath {
                    let leaf = try await client.setActiveBranch(botId: bot.id, messageId: hit.messageId)
                    guard owns(identity), !Task.isCancelled else { return nil }
                    state.apply(.thread(threadId: hit.threadId, activeLeafId: leaf))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                guard owns(identity), !Task.isCancelled else { return nil }
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return state.bot(bot.id).map(Chat.bot)
            }
            if let groupId = hit.groupId,
               let room = state.rooms.first(where: { $0.id == groupId }) {
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                guard owns(identity), !Task.isCancelled else { return nil }
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return .room(room)
            }
        } catch { if owns(identity), !Task.isCancelled { actionError = error.localizedDescription } }
        return nil
    }

    func consumeFocus(_ messageId: String) {
        if focusedMessageId == messageId { focusedMessageId = nil }
    }

    /// The chat a thread belongs to, bot or room — the lookup a notification
    /// tap needs to turn a bare threadId into something the roster can open.
    func chat(forThread threadId: String) -> Chat? {
        if let bot = state.bot(forThread: threadId) { return .bot(bot) }
        if let room = state.room(forThread: threadId) { return .room(room) }
        return nil
    }

    func createTask(for bot: Bot, title: String?) async {
        guard let client else { return }
        let identity = seedSessionId
        do {
            let updated = try await client.createTask(botId: bot.id, title: title)
            guard owns(identity), !Task.isCancelled else { return }
            state.apply(.bot(updated))
        } catch { if owns(identity), !Task.isCancelled { actionError = error.localizedDescription } }
    }

    func switchTask(_ task: BotTask, for bot: Bot) async {
        guard let client, task.threadId != bot.threadId else { return }
        let identity = seedSessionId
        do {
            let updated = try await client.switchTask(botId: bot.id, threadId: task.threadId)
            guard owns(identity), !Task.isCancelled else { return }
            state.apply(.bot(updated))
        } catch { if owns(identity), !Task.isCancelled { actionError = error.localizedDescription } }
    }

    func renameTask(_ task: BotTask, for bot: Bot, title: String) async {
        guard let client else { return }
        let identity = seedSessionId
        do {
            try await client.renameTask(botId: bot.id, threadId: task.threadId, title: title)
            guard owns(identity), !Task.isCancelled else { return }
            await refresh()
        } catch { if owns(identity), !Task.isCancelled { actionError = error.localizedDescription } }
    }

    func deleteTask(_ task: BotTask, for bot: Bot) async {
        guard let client else { return }
        let identity = seedSessionId
        do {
            let updated = try await client.deleteTask(botId: bot.id, threadId: task.threadId)
            guard owns(identity), !Task.isCancelled else { return }
            state.apply(.bot(updated))
        } catch { if owns(identity), !Task.isCancelled { actionError = error.localizedDescription } }
    }

    func react(to message: Message, in threadId: String, emoji: String) async {
        guard let client else { return }
        let identity = seedSessionId
        do {
            let patched = try await client.toggleReaction(threadId: threadId, messageId: message.id, emoji: emoji)
            guard owns(identity), !Task.isCancelled else { return }
            state.apply(.messagePatch(threadId: threadId, message: patched))
        } catch { if owns(identity), !Task.isCancelled { actionError = error.localizedDescription } }
    }

    func edit(_ message: Message, for bot: Bot, text: String) async {
        guard !state.unresolvedSeedAnswerUser(threadId: bot.threadId, messageId: message.id) else {
            actionError = "Use the saved question to check status or start this task."
            return
        }
        await perform { try await $0.edit(botId: bot.id, messageId: message.id, text: text) }
    }

    func switchVersion(to message: Message, for bot: Bot) async {
        guard let client else { return }
        let identity = seedSessionId
        do {
            let leaf = try await client.setActiveBranch(botId: bot.id, messageId: message.id)
            guard owns(identity), !Task.isCancelled else { return }
            state.apply(.thread(threadId: bot.threadId, activeLeafId: leaf))
        } catch { if owns(identity), !Task.isCancelled { actionError = error.localizedDescription } }
    }

    func export(threadId: String, format: String) async -> URL? {
        guard let client else { return nil }
        let identity = seedSessionId
        do {
            let exported = try await client.export(threadId: threadId, format: format)
            guard owns(identity), !Task.isCancelled else { return nil }
            let name = URL(fileURLWithPath: exported.filename).lastPathComponent
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try exported.data.write(to: url, options: .atomic)
            return url
        } catch {
            guard owns(identity), !Task.isCancelled else { return nil }
            actionError = error.localizedDescription
            return nil
        }
    }

    func refreshNotificationAuthorization() async {
        notificationAuthorization = await NotificationCoordinator.shared.authorizationStatus()
    }

    func enableNotifications() async {
        if notificationAuthorization == .denied {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
            return
        }
        _ = await NotificationCoordinator.shared.requestAuthorization()
        await refreshNotificationAuthorization()
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    var notificationStatusText: String {
        switch notificationAuthorization {
        case .authorized: return "On"
        case .provisional: return "Quietly on"
        case .ephemeral: return "Temporarily on"
        case .denied: return "Off in Settings"
        case .notDetermined: return "Not enabled"
        @unknown default: return "Unknown"
        }
    }

    private func perform(quietly: Bool = false, _ body: (CompanionClient) async throws -> Void) async {
        guard let client else { return }
        let identity = seedSessionId
        do {
            try await body(client)
        } catch let error as APIError where error.isUnauthorized {
            guard owns(identity), !Task.isCancelled else { return }
            status = .unauthorized
        } catch {
            guard owns(identity), !Task.isCancelled else { return }
            if !quietly { actionError = error.localizedDescription }
        }
    }
}

/// A chat is a bot or a room. They share a thread, which is what every
/// message, approval and page is keyed by.
enum Chat: Identifiable, Hashable {
    case bot(Bot)
    case room(Room)

    var id: String {
        switch self {
        case let .bot(bot): return bot.id
        case let .room(room): return room.id
        }
    }

    static func == (left: Chat, right: Chat) -> Bool {
        switch (left, right) {
        case let (.bot(a), .bot(b)): return a.id == b.id
        case let (.room(a), .room(b)): return a.id == b.id
        default: return false
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case let .bot(bot):
            hasher.combine(0)
            hasher.combine(bot.id)
        case let .room(room):
            hasher.combine(1)
            hasher.combine(room.id)
        }
    }

    var threadId: String {
        switch self {
        case let .bot(bot): return bot.threadId
        case let .room(room): return room.threadId
        }
    }

    var name: String {
        switch self {
        case let .bot(bot): return bot.name
        case let .room(room): return room.name
        }
    }

    var subtitle: String {
        switch self {
        case let .bot(bot): return bot.title
        case let .room(room): return "\(room.memberIds.count) bots"
        }
    }

    var unread: Bool {
        switch self {
        case let .bot(bot): return bot.unread
        case let .room(room): return room.unread
        }
    }

    var busy: Bool {
        switch self {
        case let .bot(bot): return bot.busy ?? false
        case let .room(room): return room.busyBotId != nil
        }
    }

    var color: String {
        switch self {
        case let .bot(bot): return bot.color
        case .room: return "blue"
        }
    }

    /// The bot's face state — the same derivation the web's stateForBot
    /// makes from what the roster record carries (pinned expression, busy,
    /// unread). Rooms have no face of their own and rest at idle.
    var mascotState: String {
        switch self {
        case let .bot(bot): return flowerState(for: bot)
        case .room: return "idle"
        }
    }

    /// The open task's title, for the chat header's task label. Nil when the
    /// thread has no titled task — the label stays out of the way entirely
    /// rather than showing a placeholder.
    var taskTitle: String? {
        guard case let .bot(bot) = self else { return nil }
        guard let title = bot.tasks?.first(where: { $0.threadId == bot.threadId })?.title,
              !title.isEmpty else { return nil }
        return title
    }
}

/// A chat plus the two things a roster row shows that the record itself does
/// not carry: the preview line, and when the thread last moved. Both come out
/// of the same message — the last one in the transcript.
struct ChatSummary: Identifiable, Hashable {
    let chat: Chat
    let preview: String
    let lastActivity: Double
    let pinned: Bool

    var id: String { chat.id }
}

extension CompanionState {
    /// Everything worth showing in the chat list: pinned first, then unread,
    /// then most recently active. Hidden bots stay hidden.
    ///
    /// The derived fields are computed once here rather than asked for as the
    /// list is sorted and filtered. Each one walks a thread's messages to
    /// reach the last of them, and a comparator is called O(n log n) times
    /// while the search predicate runs over every chat on every keystroke —
    /// so the same transcript was being traversed dozens of times per frame
    /// to produce an answer that had not changed. One pass, then sort the
    /// results.
    var chatSummaries: [ChatSummary] {
        let bots = self.bots.filter { $0.hidden != true }.map(Chat.bot)
        let rooms = self.rooms.map(Chat.room)
        return (bots + rooms)
            .map { chat in
                let last = visibleTranscript(forThread: chat.threadId).last
                return ChatSummary(
                    chat: chat,
                    preview: Self.preview(of: last),
                    lastActivity: last?.at ?? 0,
                    pinned: Self.pinned(chat)
                )
            }
            .sorted { left, right in
                if left.pinned != right.pinned { return left.pinned }
                if left.chat.unread != right.chat.unread { return left.chat.unread }
                return left.lastActivity > right.lastActivity
            }
    }

    private static func pinned(_ chat: Chat) -> Bool {
        if case let .bot(bot) = chat { return bot.pinned ?? false }
        return false
    }

    /// The one line a roster row shows under the name, from whichever kind of
    /// message landed last.
    private static func preview(of last: Message?) -> String {
        guard let last else { return "" }
        switch last.kind {
        case .text: return last.text ?? ""
        case .options: return last.card?.isPending == true ? "Waiting on you" : (last.card?.title ?? "")
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        case .unknown: return last.text ?? ""
        }
    }
}
