import CompanionCore
import Foundation
import Security
import XCTest
@testable import MusterMacCore

// ============================================================================
// Native Mac pending-sign-in lifecycle — acceptance suite
//
// Defect under test (assignment §"Defect to reproduce"):
//   At reviewed source 3191781, `SignInView.signIn()` in
//   `macos/Sources/MusterMac/MusterMacApp.swift:134-154` started an unstructured
//   `Task`, awaited authentication, then persisted the returned account and
//   connected — with no app-wide attempt check. `LiveSessionModel`'s generation
//   fencing protects work *after* `connect`, not this earlier response.
//
// `LegacyUnfencedSignInPath` below is a VERBATIM transcription of that code
// path (same order of operations, same unconditional tail writes, same
// per-view `busy` guard). It is retained deliberately: the
// `testLegacy*` cases prove the old path really does misbehave, so the new
// coordinator's guards are demonstrably load-bearing rather than decorative.
//
// Every test uses synthetic accounts, a fake protected-storage double and a
// held-response authenticator. The user's real Keychain is never read or
// written.
// ============================================================================

// MARK: - Test doubles

/// Fake protected storage. Models Keychain status results without touching any
/// Security API, matching the convention already used by SessionKeychainTests.
final class FakeSessionStore: SessionKeychainStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Data?
    var addStatus: OSStatus = errSecSuccess
    var updateStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess
    private(set) var saveCount = 0
    private(set) var clearCount = 0

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        guard addStatus == errSecSuccess else { return addStatus }
        guard bytes == nil else { return errSecDuplicateItem }
        bytes = attributes[kSecValueData as String] as? Data
        saveCount += 1
        return errSecSuccess
    }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        guard updateStatus == errSecSuccess else { return updateStatus }
        guard bytes != nil else { return errSecItemNotFound }
        bytes = attributes[kSecValueData as String] as? Data
        saveCount += 1
        return errSecSuccess
    }
    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        return bytes.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
    }
    func delete(_ query: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        clearCount += 1
        guard deleteStatus == errSecSuccess else { return deleteStatus }
        guard bytes != nil else { return errSecItemNotFound }
        bytes = nil
        return errSecSuccess
    }

    /// Stored account, decoded the same way the app decodes it on restore.
    var storedAccount: HarnessAccount? {
        lock.lock(); defer { lock.unlock() }
        guard let bytes else { return nil }
        return try? JSONDecoder().decode(HarnessAccount.self, from: bytes)
    }
    var hasStoredBytes: Bool { lock.lock(); defer { lock.unlock() }; return bytes != nil }
}

/// Held-response authentication: nothing resolves until the test releases it.
/// Deliberately ignores task cancellation — a transport may complete despite
/// cancellation, so cancellation alone cannot be the fix.
actor HeldAuthenticator {
    private struct Waiter {
        let email: String
        let continuation: CheckedContinuation<HarnessAccount, Error>
    }
    private var pending: [Waiter] = []
    private(set) var calls = 0
    private(set) var seen: [NativeSignInCoordinator.SignInInputs] = []

    func authenticate(_ inputs: NativeSignInCoordinator.SignInInputs) async throws -> HarnessAccount {
        calls += 1
        seen.append(inputs)
        let email = inputs.email
        return try await withCheckedThrowingContinuation { continuation in
            pending.append(Waiter(email: email, continuation: continuation))
        }
    }
    var waiting: Int { pending.count }

    /// Resolves the request identified by the submitted email, not simply the
    /// oldest one — a FIFO queue would hand a response to the wrong attempt and
    /// hide exactly the ordering bug these tests exist to catch.
    func release(_ account: HarnessAccount, for email: String) {
        guard let index = pending.firstIndex(where: { $0.email == email }) else {
            XCTFail("No held request for \(email); holding: \(pending.map(\.email))")
            return
        }
        pending.remove(at: index).continuation.resume(returning: account)
    }
    func fail(_ error: Error, for email: String) {
        guard let index = pending.firstIndex(where: { $0.email == email }) else {
            XCTFail("No held request for \(email); holding: \(pending.map(\.email))")
            return
        }
        pending.remove(at: index).continuation.resume(throwing: error)
    }
    func releaseAll(_ error: Error) { for w in pending { w.continuation.resume(throwing: error) }; pending = [] }
}

/// Minimal transport that answers `roster` only when told to, so a connected
/// model can be observed without any network.
actor QuietNativeTransport: NativeSessionTransport {
    private var rosters: [CheckedContinuation<Fleet, Error>] = []
    private var streams: [CheckedContinuation<Void, Error>] = []
    private(set) var streamCount = 0
    var waitingRosters: Int { rosters.count }

    func roster(messages: Int) async throws -> Fleet { try await withCheckedThrowingContinuation { rosters.append($0) } }
    func memory(botId: String) async throws -> String { "synthetic-memory" }
    func send(text: String, to botId: String, clientIntentId: String) async throws -> SendReceipt {
        SendReceipt(intentId: clientIntentId, messageId: "synthetic", threadId: "t", state: "accepted")
    }
    func respond(botId: String, requestId: String, behavior: String, message: String?) async throws -> MusterMacCore.ApprovalOutcome {
        try JSONDecoder().decode(MusterMacCore.ApprovalOutcome.self, from: Data(#"{"ok":true}"#.utf8))
    }
    func events(lastEventId: String?, onEvent: @escaping @Sendable (StreamFrame) -> Void,
                onHello: @escaping @Sendable (String, Bool) -> Void) async throws {
        streamCount += 1
        try await withCheckedThrowingContinuation { streams.append($0) }
    }
    func releaseRoster(_ value: Fleet) { rosters.removeFirst().resume(returning: value) }
    func finish() {
        for value in rosters { value.resume(throwing: CancellationError()) }; rosters = []
        for value in streams { value.resume(throwing: CancellationError()) }; streams = []
    }
}

// MARK: - Legacy path, transcribed from 3191781

/// Verbatim transcription of `SignInView.signIn()` at reviewed source 3191781.
///
/// Same order of operations (await → save → connect), same per-view `busy`
/// guard, same unconditional tail writes. `resetTransientStateForViewRecreation`
/// models SwiftUI giving `SignInView` a fresh identity — `GateView` switches on
/// `live.state`, so a state transition re-creates the view and its `@State`
/// `busy` returns to `false` while an earlier `Task` is still running.
@MainActor
final class LegacyUnfencedSignInPath {
    private(set) var busy = false
    private(set) var error: String?
    private(set) var saves = 0

    init(live: LiveSessionModel, store: FakeSessionStore, auth: @escaping @Sendable (NativeSignInCoordinator.SignInInputs) async throws -> HarnessAccount) {
        self.live = live
        self.store = store
        self.auth = auth
    }
    private let live: LiveSessionModel
    private let store: FakeSessionStore
    private let auth: @Sendable (NativeSignInCoordinator.SignInInputs) async throws -> HarnessAccount

    func resetTransientStateForViewRecreation() { busy = false }

    func signIn(origin: String, email: String, password: String, mode: MusterTransport.SignInMode) {
        guard !busy else { return }
        busy = true
        error = nil
        let originText = origin.trimmingCharacters(in: .whitespaces)
        let inputs = NativeSignInCoordinator.SignInInputs(origin: originText, email: email, password: password, mode: mode)
        Task {
            do {
                let account = try await auth(inputs)
                try SessionKeychain.save(account, storage: store)
                saves += 1
                live.connect(account: account)
            } catch let storageError as SessionKeychainError {
                error = storageError.localizedDescription
            } catch let transportError as MusterTransportError {
                error = describe(transportError)
            } catch {
                self.error = "Could not reach the server."
            }
            busy = false
        }
    }

    /// Copied verbatim from `SignInView.describe(_:)` at reviewed source 3191781,
    /// so the transcription's error surface matches the original exactly.
    private func describe(_ transportError: MusterTransportError) -> String {
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

/// Main-actor mutable box for the single-turn sentinel observation.
@MainActor
final class Sentinel {
    var ran = false
}

/// Lets a `saveAccount` closure re-enter its own coordinator, which Swift forbids
/// capturing directly in the initializer.
@MainActor
final class CoordinatorBox {
    var value: NativeSignInCoordinator?
}

// MARK: - Shared fixtures

@MainActor
final class NativeSignInLifecycleTests: XCTestCase {
    private func account(_ name: String) -> HarnessAccount {
        HarnessAccount(origin: "https://\(name).fixture.invalid", cookieName: "better-auth.session_token", cookieValue: "synthetic-\(name)")
    }
    private func inputs(_ name: String, mode: MusterTransport.SignInMode = .signIn) -> NativeSignInCoordinator.SignInInputs {
        NativeSignInCoordinator.SignInInputs(origin: "https://\(name).fixture.invalid", email: "\(name)@fixture.invalid", password: "synthetic-\(name)", mode: mode)
    }

    // ========================================================================
    // PHASE 1 — witness of the 3191781 defect.
    //
    // `LegacyUnfencedSignInPath` is a verbatim transcription of the reviewed
    // `SignInView.signIn()` (same await → save → connect order, same per-view
    // `busy` guard, same unconditional `busy = false` / `error = …` tail).
    // `resetTransientStateForViewRecreation()` models SwiftUI handing
    // `SignInView` a fresh identity when `GateView` switches on `live.state`,
    // which returns `@State busy` to false while an earlier unstructured `Task`
    // is still running.
    //
    // These cases assert what that old path DID — each one a defect the repaired
    // coordinator now prevents. They were first authored asserting the required
    // behaviour and observed RED against unmodified 3191781 (5 failing cases,
    // 2 passing positive controls, 8 failed assertions; exit 1); inverting them here keeps the evidence in the suite permanently
    // and keeps CI green. Each names the coordinator test that fixes it.
    // ========================================================================

    /// Witness for acceptance 2. Fixed by
    /// `testCoordinatorCompletionAfterDisconnectCannotSaveReconnectOrRepopulate`.
    func testLegacyWitnessStaleSuccessAfterSignOutPersistsAndReconnects() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let legacy = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }

        live.connect(account: account("current"))
        try await waitFor { await transport.waitingRosters == 1 }
        await transport.releaseRoster(fleet("current"))
        try await waitFor { if case .live = live.state { return true }; return false }

        legacy.signIn(origin: "https://old.fixture.invalid", email: "old@fixture.invalid", password: "synthetic-old", mode: .signIn)
        try await waitFor { await auth.waiting == 1 }
        live.disconnect()
        try await waitFor { if case .signedOut = live.state { return true }; return false }

        await auth.release(account("old"), for: "old@fixture.invalid")
        try await settle()

        // DEFECT: the old path persists credentials and reconnects after sign-out.
        XCTAssertTrue(store.hasStoredBytes)
        XCTAssertEqual(live.account, account("old"))
    }

    /// Witness for acceptance 3. Fixed by
    /// `testCoordinatorOlderSuccessCannotReplaceNewerActiveOrStoredCredentials`.
    func testLegacyWitnessLateOlderSuccessReplacesNewerActiveAndStoredAccount() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let legacy = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }

        legacy.signIn(origin: "https://old.fixture.invalid", email: "old@fixture.invalid", password: "synthetic-old", mode: .signIn)
        try await waitFor { await auth.waiting == 1 }
        legacy.resetTransientStateForViewRecreation()
        legacy.signIn(origin: "https://new.fixture.invalid", email: "new@fixture.invalid", password: "synthetic-new", mode: .signIn)
        try await waitFor { await auth.waiting == 2 }

        await auth.release(account("new"), for: "new@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("new"))

        await auth.release(account("old"), for: "old@fixture.invalid")
        try await settle()

        // DEFECT: the late older success replaces the newer account and the
        // bytes already on disk.
        XCTAssertEqual(live.account, account("old"))
        XCTAssertEqual(store.storedAccount, account("old"))
    }

    /// Witness for acceptance 4. Fixed by
    /// `testCoordinatorOlderFailureCannotResetNewerAttemptErrorOrBusyState`.
    func testLegacyWitnessStaleFailureClearsNewerAttemptBusyState() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let legacy = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }

        legacy.signIn(origin: "https://old.fixture.invalid", email: "old@fixture.invalid", password: "synthetic-old", mode: .signIn)
        try await waitFor { await auth.waiting == 1 }
        legacy.resetTransientStateForViewRecreation()
        legacy.signIn(origin: "https://new.fixture.invalid", email: "new@fixture.invalid", password: "synthetic-new", mode: .signIn)
        try await waitFor { await auth.waiting == 2 }
        XCTAssertTrue(legacy.busy)

        await auth.fail(MusterTransportError.signInFailed(401), for: "old@fixture.invalid")
        try await settle()

        // DEFECT: the older failure's unconditional tail clears the newer
        // attempt's busy flag.
        XCTAssertFalse(legacy.busy)
        XCTAssertNotNil(legacy.error)
    }

    /// Witness for acceptance 5/6. Fixed by
    /// `testCoordinatorTwoWindowsAndDuplicateSubmitsHaveDeterministicOwner` and
    /// `testCoordinatorClosingOwnerCancelsItButClosingOldWindowPreservesNewerAttempt`.
    func testLegacyWitnessBothWindowsPersistAndTheClosedWindowWinsByArrivingLast() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let windowOne = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }
        let windowTwo = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }

        windowOne.signIn(origin: "https://one.fixture.invalid", email: "one@fixture.invalid", password: "synthetic-one", mode: .signIn)
        try await waitFor { await auth.waiting == 1 }
        windowTwo.signIn(origin: "https://two.fixture.invalid", email: "two@fixture.invalid", password: "synthetic-two", mode: .signIn)
        try await waitFor { await auth.waiting == 2 }

        await auth.release(account("two"), for: "two@fixture.invalid")
        try await settle()
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        // DEFECT: no deterministic owner. Both windows persist a session, and the
        // window that was closed wins purely by answering last.
        XCTAssertEqual(store.saveCount, 2)
        XCTAssertEqual(live.account, account("one"))
    }

    /// Witness for acceptance 9. Fixed by
    /// `testCoordinatorStartupRestoreAndExternalAccountChangeSupersedePendingSignIn`.
    func testLegacyWitnessPendingSignInOverridesEstablishedRestoredSession() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let legacy = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }

        legacy.signIn(origin: "https://typed.fixture.invalid", email: "typed@fixture.invalid", password: "synthetic-typed", mode: .signIn)
        try await waitFor { await auth.waiting == 1 }

        // The `.task` restore in MusterMacApp.swift connects a saved session.
        live.connect(account: account("restored"))
        try await waitFor { await transport.waitingRosters == 1 }
        await transport.releaseRoster(fleet("restored"))
        try await settle()
        XCTAssertEqual(live.account, account("restored"))

        await auth.release(account("typed"), for: "typed@fixture.invalid")
        try await settle()

        // DEFECT: the still-pending sign-in overrides the established session.
        XCTAssertEqual(live.account, account("typed"))
    }

    // =========================================================================
    // Guards added after independent review. Each one exists because a mutation
    // of the product source passed the whole suite before it was written:
    //   F3 — deleting every `isCurrent` check still passed 20/20, because every
    //        real invalidator also cancels, so ownership was untested.
    //   F4 — making `adopt` async and awaiting between the save and the connect
    //        still passed 20/20, so the single-turn guarantee was untested.
    //   F1 — an unrelated window's keystroke cancelled a valid sign-in.
    // =========================================================================

    /// F3. Ownership must hold on its own, with no cancellation involved.
    ///
    /// Every production invalidator both bumps the generation and cancels the
    /// task, so `Task.isCancelled` and the ownership check are indistinguishable
    /// in normal operation. This advances the generation WITHOUT cancelling,
    /// which is the only way to prove the fence is load-bearing. Deleting the
    /// `isCurrent` checks in `run`/`adopt` makes this test fail.
    func testOwnershipFenceHoldsWithoutAnyTaskCancellation() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }

        // Supersede ownership only. The task is NOT cancelled and NOT cancelled-
        // aware, so only the generation/id comparison can stop adoption.
        signIn.supersedeWithoutCancellingForTesting()
        XCTAssertFalse(Task.isCancelled, "Precondition: nothing cancelled this task")

        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertFalse(store.hasStoredBytes, "Ownership loss alone must block the save")
        XCTAssertNil(live.account, "Ownership loss alone must block activation")
    }

    /// F4. The protected save and the activation must share one main-actor turn.
    ///
    /// `saveAccount` enqueues a sentinel onto the main actor. If `adopt` awaits
    /// anything between the save and `live.connect`, that sentinel runs first and
    /// is observed set at activation time. The observation is taken inside the
    /// model's external-change hook — i.e. exactly at the moment `connect` runs.
    func testProtectedSaveAndActivationShareOneMainActorTurn() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()

        let sentinel = Sentinel()
        let made = NativeSignInCoordinator(
            live: live,
            authenticate: { try await auth.authenticate($0) },
            saveAccount: { account in
                // Queued, not awaited: it runs at the next main-actor suspension.
                Task { @MainActor in sentinel.ran = true }
                try SessionKeychain.save(account, storage: store)
            }
        )
        var sentinelAtActivation: Bool?
        live.onSessionWillChangeExternally = {
            sentinelAtActivation = sentinel.ran
            made.invalidateForExternalSessionChange()
        }
        addTeardownBlock { @MainActor in
            made.invalidateForShutdown()
        }

        XCTAssertTrue(made.beginAttempt(window: UUID(), inputs: inputs("one")))
        try await waitFor { await auth.waiting == 1 }
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertEqual(store.saveCount, 1, "Precondition: the save happened")
        XCTAssertEqual(live.account, account("one"), "Precondition: activation happened")
        XCTAssertEqual(sentinelAtActivation, false,
                       "Something suspended between the protected save and activation")
    }

    /// F1. An unrelated window's edit must not cancel a valid sign-in.
    ///
    /// The coordinator is app-scoped but the inputs are per-window. Comparing a
    /// second window's unsubmitted form against the owning window's snapshot
    /// silently dropped a valid attempt — an invalidator the assignment does not
    /// permit.
    func testUnrelatedWindowInputEditDoesNotCancelValidSignIn() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let owner = UUID(), bystander = UUID()

        signIn.beginAttempt(window: owner, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }

        // A second window types into its own, never-submitted form.
        signIn.inputsEdited(in: bystander, to: .init(origin: "", email: "", password: "", mode: .signUp))
        XCTAssertNotNil(signIn.attempt, "A bystander window must not cancel the owner's attempt")
        XCTAssertTrue(signIn.isBusy)

        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("one"), "The owner's sign-in still completes")
        XCTAssertEqual(store.saveCount, 1)
    }

    /// F6. One window's incomplete form must not surface an error over another
    /// window's in-flight attempt.
    func testIncompleteSubmitDoesNotOverwriteAnotherWindowsAttemptErrorState() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let owner = UUID(), bystander = UUID()

        signIn.beginAttempt(window: owner, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }

        XCTAssertFalse(signIn.beginAttempt(window: bystander, inputs: .init(origin: "", email: "", password: "", mode: .signIn)))
        XCTAssertNil(signIn.errorMessage, "A bystander's validation error must not appear over a live attempt")
        XCTAssertEqual(signIn.attempt?.window, owner)
        XCTAssertTrue(signIn.isBusy)

        // With nothing pending, the same incomplete submit does report itself.
        signIn.cancelAttempt(window: owner)
        XCTAssertFalse(signIn.beginAttempt(window: bystander, inputs: .init(origin: "", email: "", password: "", mode: .signIn)))
        XCTAssertNotNil(signIn.errorMessage)
    }

    /// Positive control for the whole file: the transcription's ordinary happy
    /// path works, so the witnesses above are about the missing fence and not a
    /// broken harness.
    func testLegacyWitnessOrdinarySuccessDoesSaveAndActivate() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let legacy = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }

        legacy.signIn(origin: "https://ok.fixture.invalid", email: "ok@fixture.invalid", password: "synthetic-ok", mode: .signIn)
        try await waitFor { await auth.waiting == 1 }
        await auth.release(account("ok"), for: "ok@fixture.invalid")
        try await settle()

        XCTAssertEqual(store.saveCount, 1)
        XCTAssertEqual(store.storedAccount, account("ok"))
        XCTAssertEqual(live.account, account("ok"))
        XCTAssertFalse(legacy.busy)
    }

    // ========================================================================
    // PHASE 2 — the repaired path.
    //
    // These drive the exact objects the app uses: `NativeSignInCoordinator`
    // plus `LiveSessionModel`, wired together by the same
    // `onSessionWillChangeExternally` hook `MusterMacApp.init` installs, with
    // protected storage through the same `SessionKeychain.save(_:storage:)`
    // seam the legacy path used. One acceptance case per assignment item 32-46.
    // ========================================================================

    @MainActor
    private func coordinator(live: LiveSessionModel, store: FakeSessionStore,
                            auth: HeldAuthenticator) -> NativeSignInCoordinator {
        let made = NativeSignInCoordinator(
            live: live,
            authenticate: { try await auth.authenticate($0) },
            saveAccount: { try SessionKeychain.save($0, storage: store) }
        )
        // Identical to MusterMacApp.init.
        live.onSessionWillChangeExternally = { [weak made] in made?.invalidateForExternalSessionChange() }
        addTeardownBlock { @MainActor in made.invalidateForShutdown() }
        return made
    }

    /// Brings a model to `.live` with a known account, for tests that need an
    /// established session before a sign-in race.
    private func establishSession(_ live: LiveSessionModel, _ transport: QuietNativeTransport, _ name: String) async throws {
        live.connect(account: account(name))
        try await waitFor { await transport.waitingRosters == 1 }
        await transport.releaseRoster(fleet(name))
        try await waitFor { if case .live = live.state { return true }; return false }
    }

    // Acceptance 1 — ordinary success saves once and activates the same account.
    func testCoordinatorOrdinarySuccessSavesOnceAndActivatesSameAccount() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        XCTAssertTrue(signIn.beginAttempt(window: window, inputs: inputs("one")))
        try await waitFor { await auth.waiting == 1 }
        XCTAssertTrue(signIn.isBusy, "The submitting window is busy while in flight")

        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertEqual(store.saveCount, 1, "Exactly one protected save")
        XCTAssertEqual(store.storedAccount, account("one"))
        XCTAssertEqual(live.account, account("one"), "The same account is activated")
        XCTAssertFalse(signIn.isBusy, "The attempt is consumed")
        XCTAssertNil(signIn.errorMessage)

        // The authenticator received the submitted snapshot verbatim, origin
        // trimmed — not a re-read of mutable view state.
        let seen = await auth.seen
        XCTAssertEqual(seen, [inputs("one")])
        let submitted = NativeSignInCoordinator.SignInInputs(
            origin: "  https://one.fixture.invalid  ", email: "one@fixture.invalid",
            password: "synthetic-one", mode: .signIn)
        signIn.beginAttempt(window: UUID(), inputs: submitted)
        try await waitFor { await auth.waiting == 1 }
        let trimmed = await auth.seen
        XCTAssertEqual(trimmed.last?.origin, "https://one.fixture.invalid", "Origin is trimmed at snapshot time")
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()
    }

    // Acceptance 2 — completion after disconnect cannot save, reconnect or
    // repopulate data.
    func testCoordinatorCompletionAfterDisconnectCannotSaveReconnectOrRepopulate() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()
        try await establishSession(live, transport, "current")

        signIn.beginAttempt(window: window, inputs: inputs("old"))
        try await waitFor { await auth.waiting == 1 }

        // The user signs out while the request is in flight.
        live.disconnect()
        try await waitFor { if case .signedOut = live.state { return true }; return false }
        XCTAssertNil(signIn.attempt, "Sign-out fences the pending attempt")

        await auth.release(account("old"), for: "old@fixture.invalid")
        try await settle()

        XCTAssertFalse(store.hasStoredBytes, "A superseded response must not persist credentials")
        XCTAssertEqual(store.saveCount, 0)
        XCTAssertNil(live.account, "A superseded response must not reconnect")
        XCTAssertTrue(live.fleet.bots.isEmpty, "Must not repopulate the roster")
        XCTAssertTrue(live.transcripts.isEmpty, "Must not repopulate transcripts")
        XCTAssertNil(signIn.errorMessage, "A stale success writes no error")
        XCTAssertFalse(signIn.isBusy)
    }

    // Acceptance 3 — an older success after a newer sign-in cannot replace
    // active or stored credentials.
    func testCoordinatorOlderSuccessCannotReplaceNewerActiveOrStoredCredentials() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let oldWindow = UUID(), newWindow = UUID()

        signIn.beginAttempt(window: oldWindow, inputs: inputs("old"))
        try await waitFor { await auth.waiting == 1 }
        signIn.beginAttempt(window: newWindow, inputs: inputs("new"))
        try await waitFor { await auth.waiting == 2 }
        XCTAssertEqual(signIn.attempt?.window, newWindow, "The newer window owns the attempt")

        await auth.release(account("new"), for: "new@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("new"))

        await auth.release(account("old"), for: "old@fixture.invalid")
        try await settle()

        XCTAssertEqual(live.account, account("new"), "A late older success must not replace the newer account")
        XCTAssertEqual(store.storedAccount, account("new"), "A late older success must not overwrite stored credentials")
        XCTAssertEqual(store.saveCount, 1, "Only the surviving attempt persisted")
    }

    // Acceptance 4 — an older failure cannot reset a newer attempt's error or
    // busy state.
    func testCoordinatorOlderFailureCannotResetNewerAttemptErrorOrBusyState() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let oldWindow = UUID(), newWindow = UUID()

        signIn.beginAttempt(window: oldWindow, inputs: inputs("old"))
        try await waitFor { await auth.waiting == 1 }
        signIn.beginAttempt(window: newWindow, inputs: inputs("new"))
        try await waitFor { await auth.waiting == 2 }

        // The OLDER attempt fails while the newer one is still in flight.
        await auth.fail(MusterTransportError.signInFailed(401), for: "old@fixture.invalid")
        try await settle()

        XCTAssertTrue(signIn.isBusy, "A stale failure must not clear the newer attempt's busy state")
        XCTAssertNil(signIn.errorMessage, "A stale failure must not write an error")
        XCTAssertEqual(signIn.attempt?.window, newWindow)
        XCTAssertFalse(store.hasStoredBytes)

        // The newer attempt still completes normally.
        await auth.release(account("new"), for: "new@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("new"))
        XCTAssertNil(signIn.errorMessage)
    }

    // Acceptance 5 — two windows and duplicate submissions have a deterministic
    // current owner.
    func testCoordinatorTwoWindowsAndDuplicateSubmitsHaveDeterministicOwner() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID(), other = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }

        // A duplicate submit from the SAME window is refused outright.
        let callsBefore = await auth.calls
        XCTAssertFalse(signIn.beginAttempt(window: window, inputs: inputs("one")),
                       "A duplicate submit from the owning window must be refused")
        let callsAfter = await auth.calls
        XCTAssertEqual(callsBefore, callsAfter, "No second authentication request may be issued")

        // A submit from ANOTHER window supersedes it and takes ownership.
        XCTAssertTrue(signIn.beginAttempt(window: other, inputs: inputs("two")))
        XCTAssertEqual(signIn.attempt?.window, other)
        try await waitFor { await auth.waiting == 2 }

        // Only the owner can resolve: the older response is inert.
        await auth.release(account("two"), for: "two@fixture.invalid")
        try await settle()
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertEqual(store.saveCount, 1, "Exactly one attempt persisted a session")
        XCTAssertEqual(live.account, account("two"), "The newer window is the deterministic owner")
    }

    // Acceptance 6 — closing the owner cancels it; closing an old window
    // preserves the newer attempt.
    func testCoordinatorClosingOwnerCancelsItButClosingOldWindowPreservesNewerAttempt() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID(), other = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }
        signIn.beginAttempt(window: other, inputs: inputs("two"))
        try await waitFor { await auth.waiting == 2 }

        // Closing the now-stale first window must not touch the newer attempt.
        signIn.cancelAttempt(window: window)
        XCTAssertEqual(signIn.attempt?.window, other, "Closing a stale window preserves the newer attempt")
        XCTAssertTrue(signIn.isBusy)

        // Closing the actual owner does cancel it.
        signIn.cancelAttempt(window: other)
        XCTAssertNil(signIn.attempt, "Closing the owner cancels its attempt")
        XCTAssertFalse(signIn.isBusy)

        await auth.releaseAll(MusterTransportError.signInFailed(401))
        try await settle()
        XCTAssertFalse(store.hasStoredBytes, "A cancelled attempt must not persist")
        XCTAssertNil(live.account, "A cancelled attempt must not activate")
        XCTAssertEqual(store.clearCount, 0, "Cancelling a request must not delete saved credentials")
    }

    // Acceptance 7 — changed inputs cannot activate an old account silently.
    func testCoordinatorChangedInputsRefuseToActivateOldAccountSilently() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }

        // The identity changes despite the form's lock, as the wired
        // `.onChange` handlers report it.
        signIn.inputsEdited(in: window, to: inputs("two"))
        XCTAssertNil(signIn.attempt, "An edit that supersedes the snapshot cancels the attempt")
        XCTAssertFalse(signIn.isBusy)

        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertFalse(store.hasStoredBytes, "A superseded identity must not be persisted")
        XCTAssertNil(live.account, "A superseded identity must not be activated")
        XCTAssertEqual(store.saveCount, 0)
    }

    // Acceptance 7 (negative half) — an edit that does NOT change the submitted
    // snapshot leaves the attempt alone, so ordinary typing is not punished.
    func testCoordinatorUnrelatedEditDoesNotCancelPendingAttempt() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }
        signIn.inputsEdited(in: window, to: inputs("one"))
        XCTAssertNotNil(signIn.attempt, "An identical report must not cancel the attempt")
        XCTAssertTrue(signIn.isBusy)

        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("one"))
        XCTAssertEqual(store.saveCount, 1)
    }

    // Acceptance 8 — save failures preserve the accepted 3191781 semantics.
    func testCoordinatorRejectedSavePreservesPreviousBytesAndDoesNotConnect() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        // A working session is already stored.
        try SessionKeychain.save(account("existing"), storage: store)
        XCTAssertEqual(store.saveCount, 1)

        // The replacement write is refused by protected storage.
        store.updateStatus = errSecAuthFailed
        signIn.beginAttempt(window: window, inputs: inputs("new"))
        try await waitFor { await auth.waiting == 1 }
        await auth.release(account("new"), for: "new@fixture.invalid")
        try await settle()

        XCTAssertEqual(store.storedAccount, account("existing"),
                       "A rejected save leaves the previously stored bytes intact")
        XCTAssertNil(live.account, "A rejected save must not connect")
        XCTAssertNotNil(signIn.errorMessage, "A rejected save is reported")
        XCTAssertFalse(signIn.isBusy)
        XCTAssertEqual(store.clearCount, 0, "A rejected save must not delete stored credentials")
    }

    // Acceptance 9 — startup restoration and external account replacement
    // supersede a pending sign-in.
    func testCoordinatorStartupRestoreAndExternalAccountChangeSupersedePendingSignIn() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        // Startup restore path: the `.task` in MusterMacApp calls connect directly.
        signIn.beginAttempt(window: window, inputs: inputs("typed"))
        try await waitFor { await auth.waiting == 1 }
        try await establishSession(live, transport, "restored")
        XCTAssertNil(signIn.attempt, "Startup restore supersedes the pending attempt")

        await auth.release(account("typed"), for: "typed@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("restored"), "The pending sign-in must not override the restored session")
        XCTAssertFalse(store.hasStoredBytes)

        // External account replacement while a new attempt is in flight.
        signIn.beginAttempt(window: window, inputs: inputs("typed2"))
        try await waitFor { await auth.waiting == 1 }
        signIn.invalidateForStartupRestore()
        XCTAssertNil(signIn.attempt)
        await auth.release(account("typed2"), for: "typed2@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("restored"))
        XCTAssertFalse(store.hasStoredBytes)
    }

    // Acceptance 10 — successful navigation/disappearance does not undo accepted
    // adoption.
    func testCoordinatorNavigationDisappearanceDoesNotUndoAcceptedAdoption() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("one"))

        // Adoption succeeded, so the view is replaced by the live shell. Anything
        // the disappearing view might do must not sign the user back out.
        signIn.cancelAttempt(window: window)
        signIn.presentInitialError("stale error from the replaced view")
        signIn.invalidateForShutdown()
        try await settle()

        XCTAssertEqual(live.account, account("one"), "Disappearance must not undo adoption")
        XCTAssertNotEqual(live.state, .signedOut)
        XCTAssertEqual(store.storedAccount, account("one"))
    }

    // Acceptance 11 — late completion after the shutdown/cancel hook cannot
    // activate an account.
    func testCoordinatorLateCompletionAfterShutdownHookCannotActivate() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }
        signIn.invalidateForShutdown()
        XCTAssertNil(signIn.attempt)

        // The transport completes despite cancellation.
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertFalse(store.hasStoredBytes, "Shutdown must fence a late response")
        XCTAssertNil(live.account)
        XCTAssertNil(signIn.errorMessage)
        XCTAssertFalse(signIn.isBusy)
    }

    // The legacy transcription stays in the suite as proof the guards are
    // load-bearing: if this ever starts passing, the reproduction has rotted.
    func testLegacyTranscriptionStillMisbehavesSoTheNewGuardsAreLoadBearing() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let legacy = LegacyUnfencedSignInPath(live: live, store: store) { try await auth.authenticate($0) }

        legacy.signIn(origin: "https://old.fixture.invalid", email: "old@fixture.invalid", password: "synthetic-old", mode: .signIn)
        try await waitFor { await auth.waiting == 1 }
        live.disconnect()
        await auth.release(account("old"), for: "old@fixture.invalid")
        try await settle()

        XCTAssertTrue(store.hasStoredBytes, "The 3191781 path still adopts after sign-out")
        XCTAssertEqual(live.account, account("old"))
    }

    // The sign-out fence must hold even when the protected clear is REJECTED. The
    // app stays connected in that case (3191781 semantics: the live session is
    // preserved and the failure is reported), so `live.disconnect()` is never
    // reached and the external-change hook never fires. `SignInView`/
    // `LiveShellView.signOut()` therefore calls `invalidateForSignOut()`
    // before touching storage; without it a pending attempt would survive a
    // failed sign-out and re-save moments later.
    func testSignOutFencesPendingAttemptEvenWhenTheProtectedClearIsRejected() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        // An existing working session that a rejected clear must preserve.
        try SessionKeychain.save(account("existing"), storage: store)
        store.deleteStatus = errSecAuthFailed   // clear() will be rejected

        signIn.beginAttempt(window: window, inputs: inputs("late"))
        try await waitFor { await auth.waiting == 1 }

        // Sign out. Storage is rejected, so the app keeps its session and never
        // disconnects — the only thing that fences the attempt is this call.
        XCTAssertThrowsError(try SessionKeychain.clear(storage: store))
        XCTAssertEqual(store.storedAccount, account("existing"), "rejected clear preserves the session")
        XCTAssertEqual(live.account, nil, "precondition: no disconnect happened on this path")
        signIn.invalidateForSignOut()

        await auth.release(account("late"), for: "late@fixture.invalid")
        try await settle()

        XCTAssertEqual(store.storedAccount, account("existing"),
                       "a late sign-in must not overwrite the preserved session")
        XCTAssertNil(live.account, "a late sign-in must not activate after a failed sign-out")
    }

    // Re-entrancy guards. Found by an independent adversarial fixture pass: the
    // shipped suite releases every response from OUTSIDE the coordinator's
    // synchronous windows, so this whole class of defect was invisible to it.
    //
    // Storage is synchronous and cannot suspend, but it can re-enter: a custom
    // `saveAccount` closure, or an `@Published` observer firing synchronously.
    // None of these channels exist in the shipped app today — these tests pin
    // the invariants so the code stays correct if one is ever added.

    /// F1a. A newer attempt begun during the protected save must not be clobbered
    /// by the stale response that is mid-adoption.
    func testNewerAttemptBegunDuringTheSaveIsNotClobberedByTheStaleResponse() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let reentered = NSMutableArray()
        let newerInputs = inputs("newer")
        let box = CoordinatorBox()
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { try await auth.authenticate($0) },
            saveAccount: { account in
                // `adopt` runs on the main actor, so this re-entry is a genuine
                // synchronous one — exactly the channel being pinned.
                MainActor.assumeIsolated {
                    if reentered.count == 0 {
                        reentered.add("once")
                        box.value?.beginAttempt(window: UUID(), inputs: newerInputs)  // second window
                    }
                }
                try SessionKeychain.save(account, storage: store)
            }
        )
        box.value = signIn
        live.onSessionWillChangeExternally = { [weak signIn] in signIn?.invalidateForExternalSessionChange() }
        addTeardownBlock { @MainActor in signIn.invalidateForShutdown() }

        signIn.beginAttempt(window: UUID(), inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertTrue(signIn.isBusy, "the newer attempt begun during the save must survive")
        XCTAssertNil(live.account, "the stale response must not activate over the newer attempt")
        XCTAssertTrue(store.hasStoredBytes, "the save itself completed; only activation is withheld")

        await auth.release(account("newer"), for: "newer@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("newer"))
        XCTAssertEqual(store.storedAccount, account("newer"))
    }

    /// F1b. A sign-out raised during the protected save must not be swallowed.
    func testSignOutRaisedDuringTheSaveIsNotSwallowedByTheStaleResponse() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let reentered = NSMutableArray()
        let box = CoordinatorBox()
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { try await auth.authenticate($0) },
            saveAccount: { account in
                MainActor.assumeIsolated {
                    if reentered.count == 0 {
                        reentered.add("once")
                        box.value?.invalidateForSignOut()
                    }
                }
                try SessionKeychain.save(account, storage: store)
            }
        )
        box.value = signIn
        addTeardownBlock { @MainActor in signIn.invalidateForShutdown() }

        signIn.beginAttempt(window: UUID(), inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }
        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()

        XCTAssertNil(live.account, "a sign-out raised during the save must not be followed by an activation")
        XCTAssertFalse(signIn.isBusy)
    }

    /// F2 — `beginAttempt` publishes four pieces of state in sequence
    /// (`attempt`, `pendingWindow`, `errorMessage`, `task`). It now re-checks the
    /// generation afterwards and stands down completely if anything invalidated
    /// the coordinator while those writes were in flight.
    ///
    /// The fix is retained, but the invariant is NOT automatically testable here:
    /// the only re-entrancy channel is a synchronous Combine observer of
    /// `@Published`, and re-entrant mutation from inside a `@Published` observer
    /// crashes the Swift runtime (observed signal 11), so a test driving it that
    /// way would prove nothing. What is asserted instead is the observable half
    /// that is reachable: an invalidation landing immediately after submission
    /// always settles the coordinator rather than stranding it.
    func testInvalidationImmediatelyAfterSubmissionAlwaysSettlesTheCoordinator() async throws {
        let transport = QuietNativeTransport(); let live = liveModel(transport)
        let store = FakeSessionStore(); let auth = HeldAuthenticator()
        let signIn = coordinator(live: live, store: store, auth: auth)
        let window = UUID()

        signIn.beginAttempt(window: window, inputs: inputs("one"))
        try await waitFor { await auth.waiting == 1 }
        signIn.invalidateForSignOut()
        try await settle()

        XCTAssertFalse(signIn.isBusy, "a stranded busy state would disable the form forever")
        XCTAssertNil(signIn.attempt)
        XCTAssertNil(signIn.pendingWindow, "no half-installed attempt may be left behind")

        await auth.release(account("one"), for: "one@fixture.invalid")
        try await settle()
        XCTAssertNil(live.account)
        XCTAssertFalse(store.hasStoredBytes)

        // The form must remain usable afterwards.
        XCTAssertTrue(signIn.beginAttempt(window: window, inputs: inputs("two")))
        try await waitFor { await auth.waiting == 1 }
        await auth.release(account("two"), for: "two@fixture.invalid")
        try await settle()
        XCTAssertEqual(live.account, account("two"))
    }

    // MARK: - Helpers

    private func fleet(_ name: String) -> Fleet {
        let sample = FixtureFleet.standard()
        var bot = sample.fleet.bots[0]
        bot.name = name
        bot.messages = sample.transcript
        return Fleet(bots: [bot], groups: [])
    }
    private func waitFor(_ predicate: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !(await predicate()) && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        guard await predicate() else {
            XCTFail("Condition did not settle", file: file, line: line)
            throw URLError(.timedOut)
        }
    }
    /// Lets queued main-actor turns and unstructured tasks run to quiescence.
    private func settle(_ turns: Int = 12) async throws {
        for _ in 0..<turns { try await Task.sleep(nanoseconds: 10_000_000) }
    }
    @MainActor
    private func liveModel(_ transport: QuietNativeTransport) -> LiveSessionModel {
        let model = LiveSessionModel(transportFactory: { _ in transport })
        addTeardownBlock { @MainActor in
            model.disconnect()
            await transport.finish()
        }
        return model
    }
}