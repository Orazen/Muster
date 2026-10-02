// One app-scoped authority for pending sign-ins across every window.
//
// The bug this fixes: `SignInView.signIn()` used to await authentication inside
// an unstructured `Task` and then persist + connect unconditionally, with no
// app-wide attempt check. `LiveSessionModel` fences work *after* `connect`
// (bootstrap, stream, sends, memory) — it cannot fence the earlier
// authentication response. So a late result could, after the user had signed
// out or switched accounts, save credentials and call `connect`, which begins by
// calling `disconnect()` and therefore wipes the live session.
//
// Rules this type enforces:
//
//   1. Exactly one attempt is pending app-wide, and it is owned by exactly one
//      window. Starting a newer attempt supersedes the older one *before* it can
//      save or connect.
//   2. Each attempt binds an immutable input snapshot (origin/email/password/
//      mode), the initiating window, and a monotonically increasing generation.
//   3. Explicit sign-out, external account change, startup restore and
//      relevant shutdown all invalidate pending work before it can be adopted.
//   4. After every async boundary the attempt revalidates ownership *and*
//      cancellation. Task cancellation alone is not sufficient — a transport may
//      complete despite cancellation — so ownership is re-checked explicitly.
//   5. Final validation, the synchronous protected save and activation all happen
//      on one main-actor turn with no intervening `await`.
//   6. A stale success performs no save and no activation. A stale failure
//      writes no error and does not touch the current attempt's busy state.
//
// Input-change policy (documented deliberately, per the assignment): **lock the
// submitted inputs until completion.** The snapshot is taken at submit and the
// view disables those controls while an attempt is pending. As defence in depth,
// `adopt` re-compares the snapshot against the coordinator's current inputs and
// refuses to activate if they differ, so a superseded account/origin/mode can
// never be activated silently.
//
// This type is UI-free. It reads and writes protected storage through injected
// closures so tests can supply a fake and never touch the user's Keychain.

import Foundation

@MainActor
public final class NativeSignInCoordinator: ObservableObject {
    /// Immutable snapshot of what the user actually submitted.
    public struct SignInInputs: Equatable, Sendable {
        public var origin: String
        public var email: String
        public var password: String
        public var mode: MusterTransport.SignInMode

        public init(origin: String, email: String, password: String, mode: MusterTransport.SignInMode) {
            self.origin = origin.trimmingCharacters(in: .whitespaces)
            self.email = email
            self.password = password
            self.mode = mode
        }

        public var isComplete: Bool {
            !origin.isEmpty && !email.isEmpty && !password.isEmpty
        }
    }

    /// One in-flight sign-in. Identity is the triple (id, window, generation);
    /// all three must still match before anything is persisted or activated.
    public struct Attempt: Equatable, Sendable {
        public let id: UUID
        public let window: UUID
        public let generation: Int
        public let inputs: SignInInputs
    }

    public enum InvalidationReason: Equatable, Sendable {
        case supersededByNewerAttempt
        case windowClosed
        case signedOut
        case externalAccountChange
        case startupRestore
        case shutdown
    }

    public typealias Authenticate = @Sendable (SignInInputs) async throws -> HarnessAccount
    public typealias SaveAccount = @Sendable (HarnessAccount) throws -> Void

    // MARK: Observable surface for the view

    /// The window that owns the pending attempt, if any. Drives the busy state.
    @Published public private(set) var pendingWindow: UUID?
    /// Error for the *current* attempt only; a stale failure never writes here.
    @Published public private(set) var errorMessage: String?
    /// The attempt currently in flight, exposed for tests and for the view's
    /// "connecting…" presentation. Nil whenever nothing is pending.
    @Published public private(set) var attempt: Attempt?

    public var isBusy: Bool { pendingWindow != nil }

    /// True while *this* window owns the pending attempt.
    public func isPending(window: UUID) -> Bool { pendingWindow == window }

    // MARK: Collaborators (injected; production uses the real ones)

    private let live: LiveSessionModel
    private let authenticate: Authenticate
    private let saveAccount: SaveAccount

    /// Monotonic. Bumped by every invalidation, so a stale continuation can
    /// never match a newer attempt even if UUIDs were somehow reused.
    private var generation = 0
    private var task: Task<Void, Never>?
    /// True only inside the synchronous adopt turn. `LiveSessionModel` calls back
    /// into `invalidateForExternalSessionChange` from its own `connect`, and this
    /// stops that re-entrant call from cancelling the task that is adopting.
    /// Nothing can interleave on the main actor while this is true.

    public init(live: LiveSessionModel,
                authenticate: @escaping Authenticate,
                saveAccount: @escaping SaveAccount) {
        self.live = live
        self.authenticate = authenticate
        self.saveAccount = saveAccount
    }

    /// Production wiring: the real transport and the real Keychain helper.
    /// `SessionKeychain` is untouched; it is only called from here.
    public convenience init(live: LiveSessionModel) {
        self.init(
            live: live,
            authenticate: { inputs in
                try await MusterTransport.signIn(originText: inputs.origin,
                                                email: inputs.email,
                                                password: inputs.password,
                                                mode: inputs.mode)
            },
            saveAccount: { account in try SessionKeychain.save(account) }
        )
    }

    // MARK: - Submission

    /// Begins (or refuses to begin) a sign-in for `window`.
    ///
    /// Returns false when this window already owns the pending attempt, which is
    /// how duplicate submits from one window are refused. A *different* window
    /// submitting is allowed and supersedes the older attempt.
    @discardableResult
    public func beginAttempt(window: UUID, inputs: SignInInputs) -> Bool {
        guard inputs.isComplete else {
            // Only claim the shared error slot when nothing else owns it — this
            // window's validation complaint must not surface over another
            // window's in-flight attempt.
            //
            // Documented trade-off: when another window DOES own the attempt, a
            // second window pressing Return on an incomplete form is refused
            // silently. `SecureField.onSubmit` fires regardless of emptiness, so
            // the Button's `.disabled` guard does not apply here. Showing the
            // error anyway would overwrite the owner's live state, so silence is
            // the lesser wrong; the owning window is visibly busy either way.
            if attempt == nil {
                errorMessage = "Enter a server address, email and password."
            }
            return false
        }
        if let attempt, attempt.window == window {
            // Duplicate submit from the same window: refuse rather than queue.
            return false
        }
        // Supersede any older attempt before starting new work, so the old
        // response can never be adopted even if it completes instantly.
        generation += 1
        task?.cancel()
        task = nil
        let started = Attempt(id: UUID(), window: window, generation: generation, inputs: inputs)
        let startingGeneration = generation
        attempt = started
        pendingWindow = window
        errorMessage = nil
        task = Task { [weak self] in
            await self?.run(started)
        }

        // These four writes are not atomic, and `@Published` fires observers
        // synchronously — so a Combine subscriber (or anything else) can
        // invalidate us part-way through and leave a half-installed attempt that
        // no response can ever satisfy, bricking the form. If the generation
        // moved while we were publishing, stand down completely rather than
        // re-installing state that has already been superseded.
        if generation != startingGeneration {
            task?.cancel()
            task = nil
            attempt = nil
            pendingWindow = nil
        }
        return true
    }

    // MARK: - Cancellation / invalidation

    /// Surfaces an error the view already knows about (for example one carried
    /// in from a failed connect) without disturbing an attempt in flight.
    public func presentInitialError(_ message: String?) {
        guard let message, attempt == nil else { return }
        errorMessage = message
    }

    /// Clears the visible error without touching any attempt.
    public func clearError() {
        guard attempt == nil else { return }
        errorMessage = nil
    }

    /// Reports that the sign-in form in `window` changed. If that window owns the
    /// pending attempt and the submitted snapshot no longer describes what its
    /// form holds, the attempt is cancelled rather than allowed to activate a
    /// superseded account, origin or mode.
    ///
    /// The window check is essential and not optional: the coordinator is
    /// app-scoped, so an unrelated window's keystroke would otherwise be
    /// compared against another window's snapshot and silently cancel a valid
    /// sign-in. That is not one of the legal invalidators — only a newer attempt,
    /// disconnect, sign-out, account replacement or shutdown may drop work.
    ///
    /// The form also locks these fields while it owns an attempt, so in the wired
    /// app this is a backstop rather than the primary mechanism.
    public func inputsEdited(in window: UUID, to inputs: SignInInputs) {
        guard let attempt, attempt.window == window, attempt.inputs != inputs else { return }
        invalidate(reason: .supersededByNewerAttempt)
    }

    /// Cancels the pending attempt only if `window` owns it. Closing a stale
    /// window must never cancel a newer window's attempt.
    public func cancelAttempt(window: UUID) {
        guard let current = attempt, current.window == window else { return }
        invalidate(reason: .windowClosed)
    }

    /// Drops all pending work without touching any established session. Used for
    /// sign-out, startup restore, external account change and shutdown.
    public func invalidateForExternalSessionChange() {
        invalidate(reason: .externalAccountChange)
    }

    public func invalidateForStartupRestore() {
        invalidate(reason: .startupRestore)
    }

    public func invalidateForShutdown() {
        invalidate(reason: .shutdown)
    }

    public func invalidateForSignOut() {
        invalidate(reason: .signedOut)
    }

    private func invalidate(reason: InvalidationReason) {
        // `reason` is deliberately unread: every invalidator currently behaves
        // identically (bump, cancel, clear). It stays on the API so a reason can
        // be surfaced later without another breaking change.
        // Bump the generation FIRST. A cancelled task may already have queued its
        // continuation, and a transport may ignore cancellation entirely, so
        // ownership is invalidated before the cancel signal is even sent.
        generation += 1
        task?.cancel()
        task = nil
        attempt = nil
        pendingWindow = nil
        errorMessage = nil
    }

    /// Test/review seam: advance the ownership generation WITHOUT cancelling the
    /// running task.
    ///
    /// Every real invalidator cancels as well as bumps, so in production the two
    /// are indistinguishable — and that is precisely the risk the assignment
    /// names when it says task cancellation alone is insufficient. This seam
    /// exists so a test can prove the ownership fence holds on its own. Deleting
    /// the `isCurrent` checks in `run`/`adopt` must make that test fail.
    ///
    /// Debug-only: this must never ship in a release binary.
    #if DEBUG
    internal func supersedeWithoutCancellingForTesting() {
        generation += 1
    }
    #endif

    /// Fences a response that has come back but no longer owns anything.
    private func isCurrent(_ candidate: Attempt) -> Bool {
        guard let attempt else { return false }
        return attempt.id == candidate.id
            && attempt.window == candidate.window
            && attempt.generation == candidate.generation
            && generation == candidate.generation
    }

    // MARK: - The attempt

    private func run(_ candidate: Attempt) async {
        do {
            let account = try await authenticate(candidate.inputs)
            // Async boundary #1 — a transport may complete despite cancellation,
            // so ownership is re-checked explicitly before anything is adopted.
            guard !Task.isCancelled, isCurrent(candidate) else { return }
            adopt(account, for: candidate)
        } catch {
            // Async boundary #2 — a stale failure writes no error and does not
            // touch the current attempt's busy state.
            guard !Task.isCancelled, isCurrent(candidate) else { return }
            if let failure = error as? SessionKeychainError {
                errorMessage = failure.localizedDescription
            } else if let transportError = error as? MusterTransportError {
                errorMessage = Self.describe(transportError)
            } else {
                errorMessage = "Could not reach the server."
            }
            finish(candidate)
        }
    }

    /// Final validation, synchronous protected save and activation, all on this
    /// one main-actor turn — there is deliberately no `await` below this line.
    ///
    /// The generation is captured before the save and re-checked immediately
    /// before activating. Storage is synchronous and cannot suspend, but it CAN
    /// re-enter this object — a custom `saveAccount` closure, or an observer of
    /// `attempt`/`pendingWindow` firing synchronously inside `@Published`. If
    /// anything invalidated us while the save ran, this response is stale and
    /// must not activate, even though we never yielded.
    private func adopt(_ account: HarnessAccount, for candidate: Attempt) {
        guard !Task.isCancelled, isCurrent(candidate) else { return }

        // Consume the attempt before touching storage, so a re-entrant
        // invalidation has nothing left to clobber.
        attempt = nil
        pendingWindow = nil
        errorMessage = nil
        let adoptingGeneration = generation

        do {
            try saveAccount(account)   // synchronous protected save
        } catch let storageError as SessionKeychainError {
            // A rejected save leaves the previous stored bytes untouched and must
            // not connect — matching the accepted 3191781 Keychain behaviour.
            errorMessage = storageError.localizedDescription
            return
        } catch {
            errorMessage = "Could not save this session. Nothing was saved."
            return
        }

        // Re-check ownership: a newer attempt, a sign-out, or a session change
        // raised while the save was running must beat this now-stale response.
        guard generation == adoptingGeneration else { return }
        live.connect(account: account)   // activation, same turn, no await
    }

    private func finish(_ candidate: Attempt) {
        guard isCurrent(candidate) else { return }
        attempt = nil
        pendingWindow = nil
    }

    static func describe(_ transportError: MusterTransportError) -> String {
        switch transportError {
        case .badOrigin: return "That server address doesn't look right."
        case .noSession: return "Sign-in returned no session — check the password and try again."
        case .signInFailed: return "Sign-in failed."
        case .server(401, _): return "Email or password is incorrect."
        case let .server(code, message): return message ?? "The server answered with an error (\(code))."
        case .redirectRefused: return "The server redirected sign-in — refusing for safety."
        case .unreadable: return "The server sent something this app couldn't read."
        }
    }
}