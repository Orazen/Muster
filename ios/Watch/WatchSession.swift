// The watch's one long-lived object: who we are paired with, what we know,
// and the stream that keeps it current.
//
// A trimmed Session, not a shared one. The phone's version carries
// notifications, screen watching, search, task management and branch
// editing — none of which belong on a wrist. What the watch keeps is the
// part that was genuinely hard and is worth keeping identical: the restore
// story (locked keychain is not "unpaired"), the stream loop with its
// exponential backoff, the cold-hydrate-on-unresumed-hello rule, and the
// no-optimistic-writes discipline. Getting any of those subtly wrong here
// would be a second implementation of the same bugs.
//
// Voice input is system dictation through the reply TextField — watchOS
// already has a first-class dictation affordance on every keyboard, so
// there is no Speech framework work here, and no microphone permission.
import Foundation
import CryptoKit
import OSLog
import SwiftUI
import CompanionCore
import WatchKit

private let log = Logger(subsystem: "com.muster.companion.watch", category: "stream")

struct WatchCallContext: Equatable {
    let sessionId: UUID
    let viewId: UUID
    let botId: String
    let threadId: String
}

@MainActor
final class WatchSession: ObservableObject {
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
            approvalCoordinator.reconcile()
            composerCoordinator.reconcile()
            hapticOnFleetChange()
            publishSnapshot()
            if let target = callTarget, state.bot(target.botId)?.threadId != target.threadId {
                calendarCoordinator.reset()
                calendarBoundContext = nil
                callCoordinator.endImmediately()
            }
        }
    }
    @Published private(set) var approvalSessionId = UUID()
    @Published private(set) var approvalActions: [ApprovalActionKey: ApprovalActionState] = [:]
    @Published private(set) var composerDrafts: [ComposerContext: ComposerDraft] = [:]
    @Published private(set) var connection: Connection?
    @Published private(set) var status: Status = .unpaired {
        didSet {
            if status != .live {
                approvalCoordinator.connectionChanged()
                composerCoordinator.connectionChanged()
                if callTarget != nil {
                    calendarCoordinator.reset()
                    calendarBoundContext = nil
                    callCoordinator.endImmediately()
                }
            }
            // Offline/unpaired must reach the complication too — a mood
            // derived only from fleet data cannot say "offline".
            publishSnapshot()
        }
    }
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?

    /// Haptic on fleet state transitions (musterwatch plan §3.1): a wrist
    /// should feel the fleet change while the mascot shows it. Only real
    /// transitions fire — not every transcript delta — and .success/.failure
    /// haptics stay owned by the approval coordinator.
    private var lastHapticMood: FleetMood?
    private func hapticOnFleetChange() {
        var isOffline = false
        if case .offline = status { isOffline = true }
        if case .unpaired = status { isOffline = true }
        let mood = FleetMood.from(
            isOffline: isOffline,
            approvals: state.pendingApprovals.count,
            working: state.bots.filter { $0.busy == true }.count,
            unread: state.bots.filter(\.unread).count + state.rooms.filter(\.unread).count
        )
        defer { lastHapticMood = mood }
        guard let previous = lastHapticMood, previous != mood else { return }
        switch mood {
        case .needsYou:
            WKInterfaceDevice.current().play(.notification)
        case .working:
            WKInterfaceDevice.current().play(.start)
        case .unread:
            WKInterfaceDevice.current().play(.notification)
        case .idle, .offline:
            break
        }
    }

    /// The fleet as one face. Precedence lives in `FleetMood` so the header
    /// and any future surface cannot disagree about what matters most.
    /// Offline rule matches the phone's publishFleetSnapshot exactly:
    /// unpaired is offline — a watch that has never connected must not
    /// glance "Up to date".
    var fleetMood: FleetMood {
        var isOffline = false
        if case .offline = status { isOffline = true }
        if case .unpaired = status { isOffline = true }
        return FleetMood.from(
            isOffline: isOffline,
            approvals: state.pendingApprovals.count,
            working: state.bots.filter { $0.busy == true }.count,
            unread: state.bots.filter(\.unread).count + state.rooms.filter(\.unread).count
        )
    }

    /// Publish the fleet snapshot for the complication (and any future
    /// out-of-process surface). Same store the phone's widget uses, so the
    /// render contract is one function — the snapshot is written on every
    /// state change and a status change; the store's freshness rule turns a
    /// stale one into "offline" at render time. A status didSet also fires
    /// this: offline/unpaired must reach the complication, not just fleet
    /// data changes.
    func publishSnapshot() {
        FleetSnapshotStore.publish(fleetSnapshot(state: state, mood: fleetMood))
    }

    private var client: CompanionClient? {
        didSet {
            streamGeneration += 1
            streamTask?.cancel()
            streamTask = nil
            approvalSessionId = UUID()
            approvalCoordinator.bind(sessionId: approvalSessionId, transport: client)
            composerCoordinator.bind(sessionId: approvalSessionId, transport: client)
            calendarCoordinator.reset()
            calendarBoundContext = nil
            callTarget = nil
            callCoordinator.bind(sessionId: approvalSessionId, transport: client)
        }
    }
    private var pairingGeneration = 0
    private lazy var approvalCoordinator = ApprovalActionCoordinator(
        readState: { [weak self] in self?.state ?? CompanionState() },
        changed: { [weak self] in self?.approvalActions = $0 },
        unauthorized: { [weak self] in self?.status = .unauthorized },
        confirmed: { _, _ in WKInterfaceDevice.current().play(.success) }
    )
    private lazy var composerCoordinator = ComposerCoordinator(
        readState: { [weak self] in self?.state ?? CompanionState() },
        changed: { [weak self] in self?.composerDrafts = $0 },
        unauthorized: { [weak self] in self?.status = .unauthorized }
    )
    private var callForeground = false
    private var callTarget: WatchCallContext?
    private lazy var callCoordinator = ForegroundCallCoordinator(changed: { [weak self] in
        self?.objectWillChange.send()
    })
    var callPhase: ForegroundCallCoordinator.Phase { callCoordinator.phase }
    var callRecord: ForegroundCallRecord? { callCoordinator.call }
    var callNotice: String? { callCoordinator.notice }
    var callPendingRequestId: String? { callCoordinator.pendingRequestId }
    var callCanDismissUnknown: Bool { callCoordinator.canDismissUnknown }
    var callEndRequested: Bool { callCoordinator.hasRequestedEnd }

    func makeCallContext(botId: String, threadId: String) -> WatchCallContext {
        WatchCallContext(sessionId: approvalSessionId, viewId: UUID(), botId: botId, threadId: threadId)
    }
    func callMatches(_ context: WatchCallContext) -> Bool {
        context.sessionId == approvalSessionId && callTarget == context
    }
    func beginCall(_ context: WatchCallContext) async {
        guard context.sessionId == approvalSessionId, callForeground, status == .live,
              state.bot(context.botId)?.threadId == context.threadId,
              state.bot(context.botId)?.busy != true, [.idle, .ended].contains(callPhase) else { return }
        callTarget = context
        await callCoordinator.begin(botId: context.botId, threadId: context.threadId)
    }
    private func callContextAvailable(_ context: WatchCallContext) -> Bool {
        callMatches(context) && callForeground && status == .live && state.bot(context.botId)?.threadId == context.threadId
    }
    func acceptCall(_ context: WatchCallContext) async {
        guard callContextAvailable(context) else { return }
        await callCoordinator.accept()
    }
    func sendCall(_ text: String, context: WatchCallContext) async {
        guard callContextAvailable(context) else { return }
        await callCoordinator.send(text)
    }
    func pollCall(_ context: WatchCallContext) async {
        guard callContextAvailable(context) else { return }
        await callCoordinator.poll()
        if callPhase == .ended { calendarCoordinator.reset(); calendarBoundContext = nil }
    }
    func endCallImmediately(_ context: WatchCallContext) {
        guard callMatches(context) else { return }
        calendarCoordinator.reset()
        calendarBoundContext = nil
        callCoordinator.endImmediately()
    }
    func dismissUnknownCall(_ context: WatchCallContext) {
        guard callMatches(context) else { return }
        callCoordinator.dismissUnknownCall()
    }

    private var calendarBoundContext: WatchCallContext?
    private var calendarBoundCallId: String?
    private lazy var calendarCoordinator = CallCalendarCoordinator(changed: { [weak self] in self?.objectWillChange.send() })
    var calendarEnrollment: CallCalendarEnrollment? { calendarCoordinator.enrollment }
    var calendarCode: String? { calendarCoordinator.code }
    var calendarIssued: CallCalendarIssued? { calendarCoordinator.issued }
    var calendarBusy: Bool { calendarCoordinator.busy }
    var calendarNotice: String? { calendarCoordinator.notice }
    private var calendarStorageKey: String? {
        guard let connection, let token = try? Keychain.token(for: connection.id) else { return nil }
        let binding = "\(connection.id)|\(connection.scheme.rawValue)|\(connection.host)|\(connection.port)|\(token)"
        return "calendar:" + SHA256.hash(data: Data(binding.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func bindCalendar(_ context: WatchCallContext) -> Bool {
        guard callContextAvailable(context), let scope = callCoordinator.calendarScope, let client, let key = calendarStorageKey else { return false }
        if calendarBoundContext != context || calendarBoundCallId != scope.callId {
            var issued: CallCalendarIssued?
            if let text = try? Keychain.token(for: key) { issued = try? JSONDecoder().decode(CallCalendarIssued.self, from: Data(text.utf8)) }
            calendarBoundContext = context; calendarBoundCallId = scope.callId
            calendarCoordinator.bind(scope: scope, transport: client, issued: issued, save: { value in
                let data = try JSONEncoder().encode(value)
                try Keychain.save(String(decoding: data, as: UTF8.self), for: key)
            })
        }
        return true
    }
    func loadCalendar(_ context: WatchCallContext) { _ = bindCalendar(context) }
    func beginCalendarEnrollment(_ context: WatchCallContext) async {
        guard bindCalendar(context) else { return }
        await calendarCoordinator.start()
    }
    func checkCalendarEnrollment(_ context: WatchCallContext) async {
        guard bindCalendar(context) else { return }
        await calendarCoordinator.check()
    }
    func cancelCalendarEnrollment(_ context: WatchCallContext) async {
        guard callMatches(context), calendarBoundContext == context else { return }
        await calendarCoordinator.cancel()
    }
    func prepareCalendar(_ input: CallCalendarPlanRequest, context: WatchCallContext) async -> CallCalendarPlanDraft? {
        guard bindCalendar(context) else { return nil }
        let callId = callRecord?.id
        let result = await calendarCoordinator.prepare(input)
        guard callContextAvailable(context), callRecord?.id == callId, callPhase == .connected else { return nil }
        return result
    }

    private var streamTask: Task<Void, Never>?
    /// Identifies the task currently stored in `streamTask`. A cancelled task
    /// can finish after its replacement starts; its cleanup must not clear
    /// the replacement's handle.
    private var streamGeneration = 0
    private var reconnectDelay: UInt64 = 0
    /// A saved connection exists, but its token could not be read yet. Keeps
    /// "the keychain is locked" from being mistaken for "not paired".
    private var restorePending = false

    private static let connectionKey = "companion.connection"

    init() {
        restore()
        // A fresh install reaches no didSet — no state arrives, status never
        // changes from .unpaired — so the complication would show nothing
        // until the first successful sync. Publish the honest empty truth
        // immediately: the face reads "Offline" until pairing connects.
        publishSnapshot()
    }

    // MARK: - Pairing

    /// Rebuild the last connection at launch. The three-outcome story from
    /// the phone, with the watch's own unlock in place of the phone's: no
    /// saved connection stays unpaired; a readable token connects; a token
    /// that cannot be read *yet* — the wrist was not unlocked after a reboot
    /// — holds on and retries rather than demanding a new code.
    private func restore() {
        restorePending = false
        guard let data = UserDefaults.standard.data(forKey: Self.connectionKey),
              let saved = try? JSONDecoder().decode(Connection.self, from: data)
        else { return }

        let stored: String?
        do {
            stored = try Keychain.token(for: saved.id)
        } catch {
            connection = saved
            restorePending = true
            status = .offline(
                (error as? KeychainError)?.isLocked == true
                    ? "Unlock this watch to reach your computer."
                    : error.localizedDescription
            )
            return
        }
        guard let stored else { return } // no token: genuinely not paired

        connection = saved
        client = CompanionClient(connection: saved, token: stored)
        status = .connecting
    }

    /// Redeem the six-digit code shown by Companion on the computer. The
    /// high-entropy QR credential is a phone affordance — no camera here —
    /// and the sidecar keeps accepting the manual code for exactly this
    /// client. On success the token goes to the keychain and the connection
    /// to defaults, deliberately apart, so the thing that gets backed up is
    /// never the credential.
    func pair(with connection: Connection, credential: String) async throws {
        pairingGeneration += 1
        let generation = pairingGeneration
        let paired = try await CompanionClient.pair(
            connection: connection,
            credential: credential,
            deviceName: WKInterfaceDevice.current().name
        )
        try Task.checkCancellation()
        guard pairingGeneration == generation else { throw CancellationError() }
        // prefer the name the computer calls itself over the Bonjour label
        var stored = connection
        if !paired.serverName.isEmpty { stored.name = paired.serverName }

        try Keychain.save(paired.token, for: stored.id)
        UserDefaults.standard.set(try? JSONEncoder().encode(stored), forKey: Self.connectionKey)

        self.connection = stored
        self.client = CompanionClient(connection: stored, token: paired.token)
        self.state = CompanionState()
        restorePending = false
        connect()
    }

    /// Adopt a pairing handed over by the phone (WatchConnectivity). The
    /// phone paired normally and shares the outcome; the watch skips the
    /// six-digit code entirely. Same postconditions as pair(with:): token
    /// to the keychain, connection to defaults, client built, connected.
    func adoptHandoff(_ handoff: CompanionHandoff) {
        pairingGeneration += 1
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        restorePending = false
        // A previous pairing's token has no business outliving its adoption.
        if let old = connection?.id, old != handoff.connection.id { Keychain.remove(old) }
        do {
            try Keychain.save(handoff.token, for: handoff.connection.id)
        } catch {
            status = .offline("Could not store the pairing from your phone: \(error.localizedDescription)")
            return
        }
        UserDefaults.standard.set(try? JSONEncoder().encode(handoff.connection), forKey: Self.connectionKey)
        connection = handoff.connection
        client = CompanionClient(connection: handoff.connection, token: handoff.token)
        state = CompanionState()
        status = .connecting
        reconnectDelay = 0
        connect()
    }

    func signOut() {
        pairingGeneration += 1
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        restorePending = false
        if let key = calendarStorageKey { Keychain.remove(key) }
        if let id = connection?.id { Keychain.remove(id) }
        UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        connection = nil
        client = nil
        state = CompanionState()
        status = .unpaired
    }

    // MARK: - Lifecycle

    /// Called when the wrist wakes the app, and once at launch.
    func connect() {
        // A restore that found the keychain locked left `client` nil on
        // purpose. Coming to the front is the moment worth retrying on.
        if client == nil, restorePending { restore() }
        guard let client, streamTask == nil else { return }
        let identity = approvalSessionId
        status = .connecting
        reconnectDelay = 0
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run(client: client, identity: identity, generation: generation)
            guard self.streamGeneration == generation else { return }
            self.streamTask = nil
        }
    }

    /// Called when the app leaves the screen. watchOS suspends the app
    /// moments later and kills the connection anyway; dropping it
    /// deliberately means the cursor is written down at a known point
    /// instead of wherever the socket happened to die.
    func disconnect() {
        streamGeneration += 1
        approvalCoordinator.connectionChanged()
        composerCoordinator.connectionChanged()
        streamTask?.cancel()
        streamTask = nil
    }

    func setForeground(_ active: Bool) {
        approvalCoordinator.setForeground(active)
        composerCoordinator.setForeground(active)
        callForeground = active
        if !active { calendarCoordinator.reset(); calendarBoundContext = nil }
        callCoordinator.setForegroundImmediately(active)
    }

    private func currentStream(_ identity: UUID, _ generation: Int) -> Bool {
        !Task.isCancelled && approvalSessionId == identity && streamGeneration == generation && client != nil
    }

    private func run(client: CompanionClient, identity: UUID, generation: Int) async {
        while currentStream(identity, generation) {
            approvalCoordinator.connectionChanged()
            status = .connecting
            log.info("opening stream, cursor=\(self.state.cursor ?? "none", privacy: .public)")
            do {
                // screens: false, always — a base64 desktop capture every few
                // seconds is the one thing a watch connection must never ask
                // the harness for.
                for try await frame in try client.events(since: state.cursor, screens: false) {
                    guard currentStream(identity, generation) else { return }
                    reconnectDelay = 0

                    if case let .hello(cursor, resumed) = frame.frame {
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // false means the server could not replay the gap —
                        // the one case that costs a full hydrate. Commit the
                        // hello cursor only after that hydrate succeeds.
                        if !resumed {
                            let fleet = try await client.fleet(messages: 50)
                            guard currentStream(identity, generation) else { return }
                            state.hydrate(fleet)
                            state.resetCursor(cursor)
                        }
                        status = .live
                        continue
                    }
                    state.apply(frame)
                    state.advance(to: frame.seq)
                }
                guard currentStream(identity, generation) else { return }
                approvalCoordinator.connectionChanged()
                log.notice("stream ended without an error")
                status = .offline("Lost the connection.")
            } catch let error as APIError where error.isUnauthorized {
                guard currentStream(identity, generation) else { return }
                approvalCoordinator.connectionChanged()
                log.error("stream refused: unauthorized")
                status = .unauthorized
                return
            } catch {
                if !currentStream(identity, generation) || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                approvalCoordinator.connectionChanged()
                log.error("stream failed: \(error.localizedDescription, privacy: .public)")
                status = .offline(error.localizedDescription)
            }

            if Task.isCancelled { return }
            // 1s, 2s, 4s… to 15s. A watch that woke away from the laptop's
            // network should not hammer it.
            reconnectDelay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 15)
            try? await Task.sleep(nanoseconds: reconnectDelay * 1_000_000_000)
        }
    }

    // MARK: - Actions
    //
    // Each of these does the thing and lets the event stream deliver the
    // result. Nothing here writes to `state` optimistically: the harness is
    // the source of truth, and a watch that draws its own version of events
    // is a watch that disagrees with the laptop.

    func composerContext(for chat: WatchChat) -> ComposerContext {
        let kind: ComposerTarget.Kind
        switch chat { case .bot: kind = .bot; case .room: kind = .room }
        return ComposerContext(sessionId: approvalSessionId, target: ComposerTarget(
            kind: kind, ownerId: chat.id, threadId: chat.threadId))
    }

    func viewComposer(_ context: ComposerContext) -> ComposerViewLease { composerCoordinator.enter(context) }
    func leaveComposer(_ lease: ComposerViewLease) { composerCoordinator.leave(lease) }
    func composerDraft(_ context: ComposerContext) -> ComposerDraft { composerCoordinator.draft(for: context) }
    func canEditComposer(_ context: ComposerContext, lease: ComposerViewLease?) -> Bool {
        composerCoordinator.canEdit(context, lease: lease)
    }
    func canSendComposer(_ context: ComposerContext, lease: ComposerViewLease?) -> Bool {
        status == .live && composerCoordinator.canSend(context, lease: lease)
    }
    func editComposer(_ text: String, context: ComposerContext, lease: ComposerViewLease?) {
        composerCoordinator.edit(text, context: context, lease: lease)
    }
    func submitComposer(_ context: ComposerContext, lease: ComposerViewLease?) {
        guard canSendComposer(context, lease: lease) else { return }
        composerCoordinator.submit(context, lease: lease)
    }

    func approvalContext(threadId: String) -> ComposerContext? {
        let bots = state.bots.filter { $0.threadId == threadId }
        let rooms = state.rooms.filter { $0.threadId == threadId }
        guard bots.count + rooms.count == 1 else { return nil }
        let target: ComposerTarget
        if let bot = bots.first {
            target = ComposerTarget(kind: .bot, ownerId: bot.id, threadId: threadId)
        } else if let room = rooms.first {
            target = ComposerTarget(kind: .room, ownerId: room.id, threadId: threadId)
        } else { return nil }
        return ComposerContext(sessionId: approvalSessionId, target: target)
    }

    func viewApproval(_ context: ComposerContext) -> ApprovalViewLease { approvalCoordinator.enter(context) }
    func leaveApproval(_ lease: ApprovalViewLease) { approvalCoordinator.leave(lease) }
    func approvalReference(threadId: String, message: Message) -> ApprovalReference? {
        guard let context = approvalContext(threadId: threadId) else { return nil }
        return approvalCoordinator.reference(for: context, message: message)
    }
    func approvalState(threadId: String, message: Message) -> ApprovalActionState? {
        guard let context = approvalContext(threadId: threadId), let requestId = message.card?.requestId else { return nil }
        return approvalCoordinator.actionState(for: context, cardId: message.id, requestId: requestId)
    }
    func canSubmitApproval(_ reference: ApprovalReference, lease: ApprovalViewLease?) -> Bool {
        status == .live && approvalCoordinator.canSubmit(reference, lease: lease)
    }
    func submitApproval(_ reference: ApprovalReference, action: ApprovalAction, lease: ApprovalViewLease?) {
        guard canSubmitApproval(reference, lease: lease) else { return }
        approvalCoordinator.submit(reference, action: action, lease: lease)
    }

    func interrupt(bot: Bot) async {
        await perform { try await $0.interrupt(botId: bot.id) }
    }

    func markRead(_ bot: Bot) async {
        await perform(quietly: true) { try await $0.markRead(botId: bot.id) }
    }

    func markRead(_ room: Room) async {
        await perform(quietly: true) { try await $0.markRead(roomId: room.id) }
    }

    private func perform(quietly: Bool = false, _ body: (CompanionClient) async throws -> Void) async {
        guard let client else { return }
        let identity = approvalSessionId
        do {
            try await body(client)
        } catch let error as APIError where error.isUnauthorized {
            guard identity == approvalSessionId else { return }
            status = .unauthorized
        } catch {
            guard identity == approvalSessionId else { return }
            if !quietly {
                actionError = error.localizedDescription
                // The wrist is often the only feedback: the failure is
                // otherwise a line of text the owner is not looking at.
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }
}
