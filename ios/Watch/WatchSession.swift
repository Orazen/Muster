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
import OSLog
import SwiftUI
import CompanionCore
import WatchKit

private let log = Logger(subsystem: "com.muster.companion.watch", category: "stream")

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
        didSet { approvalCoordinator.reconcile() }
    }
    @Published private(set) var approvalSessionId = UUID()
    @Published private(set) var approvalActions: [ApprovalActionKey: ApprovalActionState] = [:]
    @Published private(set) var connection: Connection?
    @Published private(set) var status: Status = .unpaired {
        didSet { if status != .live { approvalCoordinator.connectionChanged() } }
    }
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?

    /// The fleet as one face. Precedence lives in `FleetMood` so the header
    /// and any future surface cannot disagree about what matters most.
    var fleetMood: FleetMood {
        var isOffline = false
        if case .offline = status { isOffline = true }
        return FleetMood.from(
            isOffline: isOffline,
            approvals: state.pendingApprovals.count,
            working: state.bots.filter { $0.busy == true }.count,
            unread: state.bots.filter(\.unread).count + state.rooms.filter(\.unread).count
        )
    }

    private var client: CompanionClient? {
        didSet {
            streamGeneration += 1
            streamTask?.cancel()
            streamTask = nil
            approvalSessionId = UUID()
            approvalCoordinator.bind(sessionId: approvalSessionId, transport: client)
        }
    }
    private var pairingGeneration = 0
    private lazy var approvalCoordinator = ApprovalActionCoordinator(
        readState: { [weak self] in self?.state ?? CompanionState() },
        changed: { [weak self] in self?.approvalActions = $0 },
        unauthorized: { [weak self] in self?.status = .unauthorized },
        confirmed: { _, _ in WKInterfaceDevice.current().play(.success) }
    )
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

    func signOut() {
        pairingGeneration += 1
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        restorePending = false
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
        streamTask?.cancel()
        streamTask = nil
    }

    func setForeground(_ active: Bool) { approvalCoordinator.setForeground(active) }

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

    func send(_ text: String, to bot: Bot) async {
        await perform { try await $0.send(text: text, toBot: bot.id) }
    }

    func send(_ text: String, to room: Room) async {
        await perform { try await $0.send(text: text, toRoom: room.id) }
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
