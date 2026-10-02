import AppKit
import CompanionCore
import Foundation
import Security
import SwiftUI
import XCTest
@testable import MusterMac
@testable import MusterMacCore

// ============================================================================
// View-level sign-in lifecycle — CI-pinned.
//
// These drive the REAL `SignInView` with REAL `.environmentObject` wiring, hosted
// in an `NSHostingView`. SwiftPM links the app module into this test target, so
// there is no source duplication and no `@main` removal here — this is the shipped
// view, not a transcription.
//
// Substitutions, and only these:
//   * authentication is a held synthetic closure — no server, no OAuth, no token;
//   * protected storage is an in-memory overlay that still runs the REAL
//     `SessionKeychain` logic through its internal `storage:` seam.
//
// NOT proven here, and not claimed: physical multi-window behaviour on real
// hardware, real OAuth, real Keychain behaviour, installed-app behaviour. This is
// a headless render. The human Mac pass remains a separate open gate.
// ============================================================================

// MARK: - In-memory protected-storage overlay

final class InMemoryProviderStorage: SessionKeychainStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Data?
    private var successfulWrites = 0
    private(set) var ops: [String] = []
    var updateStatus: OSStatus = errSecSuccess
    var addStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        ops.append("add")
        guard addStatus == errSecSuccess else { return addStatus }
        guard bytes == nil else { return errSecDuplicateItem }
        bytes = attributes[kSecValueData as String] as? Data
        successfulWrites += 1
        return errSecSuccess
    }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        ops.append("update")
        guard updateStatus == errSecSuccess else { return updateStatus }
        guard bytes != nil else { return errSecItemNotFound }
        bytes = attributes[kSecValueData as String] as? Data
        successfulWrites += 1
        return errSecSuccess
    }
    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        ops.append("read")
        return bytes.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
    }
    func delete(_ query: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        ops.append("delete")
        guard deleteStatus == errSecSuccess else { return deleteStatus }
        guard bytes != nil else { return errSecItemNotFound }
        bytes = nil
        return errSecSuccess
    }

    // Real SessionKeychain logic over in-memory bytes.
    func save(_ account: HarnessAccount) throws { try SessionKeychain.save(account, storage: self) }
    func clear() throws { try SessionKeychain.clear(storage: self) }

    var storedAccount: HarnessAccount? {
        lock.lock(); defer { lock.unlock() }
        guard let bytes else { return nil }
        return try? JSONDecoder().decode(HarnessAccount.self, from: bytes)
    }
    var hasBytes: Bool { lock.lock(); defer { lock.unlock() }; return bytes != nil }
    /// Counts SUCCESSFUL writes only: a first save is one failed update
    /// (itemNotFound) followed by one add.
    var writeCount: Int { lock.lock(); defer { lock.unlock() }; return successfulWrites }
    var deleteCount: Int { lock.lock(); defer { lock.unlock() }; return ops.filter { $0 == "delete" }.count }
}

// MARK: - Held synthetic authentication (no server, no OAuth)

actor HeldSyntheticAuth {
    struct Waiter { let email: String; let continuation: CheckedContinuation<HarnessAccount, Error> }
    private var pending: [Waiter] = []
    private(set) var calls = 0
    /// Closed by `finish()`. A continuation that registers AFTER the drain would
    /// otherwise park forever, because nothing else resumes it.
    private var isClosed = false

    func authenticate(_ inputs: NativeSignInCoordinator.SignInInputs) async throws -> HarnessAccount {
        if isClosed { throw CancellationError() }
        calls += 1
        let email = inputs.email
        return try await withCheckedThrowingContinuation { c in
            // Re-check inside the continuation body: this actor may have been
            // closed between the guard above and here.
            if isClosed { c.resume(throwing: CancellationError()); return }
            pending.append(Waiter(email: email, continuation: c))
        }
    }
    var waiting: Int { pending.count }
    /// Observable in-flight count so a test can assert nothing was left suspended.
    var inFlight: Int { pending.count }
    func release(_ account: HarnessAccount, for email: String) {
        guard let i = pending.firstIndex(where: { $0.email == email }) else {
            XCTFail("no held request for \(email)"); return
        }
        pending.remove(at: i).continuation.resume(returning: account)
    }
    /// Close first, then drain. Idempotent.
    @discardableResult
    func finish(_ error: Error = CancellationError()) -> Int {
        isClosed = true
        let n = pending.count
        for w in pending { w.continuation.resume(throwing: error) }
        pending = []
        return n
    }
}

/// Answers nothing until told to. No network.
actor SilentSessionTransport: NativeSessionTransport {
    private var rosters: [CheckedContinuation<Fleet, Error>] = []
    private var streams: [CheckedContinuation<Void, Error>] = []
    var waitingRosters: Int { rosters.count }
    /// Observable in-flight count: checked continuations that are suspended and
    /// have not been resumed. Cancelling a Task does NOT resume these, so this is
    /// the only way to observe that a test left work parked.
    var inFlight: Int { rosters.count + streams.count }
    /// Closed by `finish()`; late registrations are refused rather than parked.
    private var isClosed = false

    func roster(messages: Int) async throws -> Fleet {
        if isClosed { throw CancellationError() }
        return try await withCheckedThrowingContinuation { c in
            if isClosed { c.resume(throwing: CancellationError()); return }
            rosters.append(c)
        }
    }
    func memory(botId: String) async throws -> String { "synthetic" }
    func send(text: String, to botId: String, clientIntentId: String) async throws -> SendReceipt {
        SendReceipt(intentId: clientIntentId, messageId: "synthetic", threadId: "t", state: "accepted")
    }
    func respond(botId: String, requestId: String, behavior: String, message: String?) async throws -> MusterMacCore.ApprovalOutcome {
        try JSONDecoder().decode(MusterMacCore.ApprovalOutcome.self, from: Data(#"{"ok":true}"#.utf8))
    }
    func events(lastEventId: String?, onEvent: @escaping @Sendable (StreamFrame) -> Void,
                onHello: @escaping @Sendable (String, Bool) -> Void) async throws {
        if isClosed { throw CancellationError() }
        return try await withCheckedThrowingContinuation { c in
            if isClosed { c.resume(throwing: CancellationError()); return }
            streams.append(c)
        }
    }
    func releaseRoster(_ value: Fleet) { rosters.removeFirst().resume(returning: value) }
    /// Close first, then drain, so a continuation registering later is refused
    /// rather than parked forever. Idempotent, because two windows share one scope
    /// and each runs its own teardown.
    @discardableResult
    func finish() -> Int {
        isClosed = true
        let n = rosters.count + streams.count
        for v in rosters { v.resume(throwing: CancellationError()) }; rosters = []
        for v in streams { v.resume(throwing: CancellationError()) }; streams = []
        return n
    }
}

// MARK: - App scope, and windows over it

/// What `MusterMacApp.init` builds ONCE for the whole process. Several windows
/// are then presented over this same scope — which is the entire point of the
/// repair, so the harness must not give each window its own authority.
@MainActor
final class AppScope {
    let live: LiveSessionModel
    let signIn: NativeSignInCoordinator
    let storage: InMemoryProviderStorage
    let auth: HeldSyntheticAuth
    let transport: SilentSessionTransport

    init() {
        let storage = InMemoryProviderStorage()
        let auth = HeldSyntheticAuth()
        let transport = SilentSessionTransport()
        let live = LiveSessionModel(transportFactory: { _ in transport })
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { try await auth.authenticate($0) },
            saveAccount: { try storage.save($0) }
        )
        live.onSessionWillChangeExternally = { [weak signIn] in signIn?.invalidateForExternalSessionChange() }
        self.storage = storage
        self.auth = auth
        self.live = live
        self.signIn = signIn
        self.transport = transport
    }

    /// Drain everything this scope left suspended.
    ///
    /// Cancelling a `Task` does not resume a `CheckedContinuation`, so a test
    /// that signs in successfully leaves the bootstrap `roster` and the stream
    /// suspended forever. This resumes them all and is idempotent.
    func finish() async {
        // 1. Invalidate the session FIRST, so the coordinator stops asking for
        //    anything and any in-flight attempt is fenced before we close.
        live.disconnect()
        // 2. Close each actor, then drain it. Closing first means a continuation
        //    that registers after this point is refused, not orphaned.
        await transport.finish()
        await auth.finish(CancellationError())
        // 3. Disconnect again: closing the transport unblocks a bootstrap roster,
        //    which may have scheduled fresh work before it saw the close.
        live.disconnect()
    }

    /// Pending waiters across BOTH doubles. Both must be zero after teardown;
    /// asserting only the transport let a late auth continuation escape.
    func pendingCounts() async -> (auth: Int, transport: Int) {
        (await auth.inFlight, await transport.inFlight)
    }
}

/// One window: its own hosting view and NSWindow over the shared scope.
@MainActor
final class WindowHarness {
    let name: String
    let live: LiveSessionModel
    let signIn: NativeSignInCoordinator
    let storage: InMemoryProviderStorage
    private let scope: AppScope
    private var host: NSHostingView<AnyView>!
    private var window: NSWindow!

    init(name: String, scope: AppScope) {
        self.name = name
        self.scope = scope
        self.live = scope.live
        self.signIn = scope.signIn
        self.storage = scope.storage
        install()
    }

    private func root() -> AnyView {
        AnyView(
            SignInView()
                .environmentObject(live)
                .environmentObject(signIn)
                .environmentObject(PrototypeModel.fixture())
                .frame(width: 520, height: 620)
        )
    }

    private func install() {
        host = NSHostingView(rootView: root())
        host.frame = .init(x: 0, y: 0, width: 520, height: 620)
        window = NSWindow(contentRect: host.frame, styleMask: [.titled, .closable],
                          backing: .buffered, defer: false)
        window.contentView = host
        pump()
        fillCredentials()
    }

    /// Rebuild the root exactly as `GateView` does when `live` publishes. This is
    /// the scenario in which a plain stored `windowID` default would regenerate.
    ///
    /// `rebuildCount` exists because this method is the ONLY thing in the suite
    /// that simulates a `GateView` rebuild. Without an assertion that a rebuild
    /// actually happened, the F2 pin below is contingent on this one line keeping
    /// its body: neutralising it lets `@State windowID -> let` pass green.
    private(set) var rebuildCount = 0
    func rebuildRoot() { rebuildCount += 1; host.rootView = root(); pump() }

    /// Remove the view from the hierarchy, which is what closing a window or
    /// navigating away does — `onDisappear` fires.
    func close() { window.contentView = NSView(frame: .zero); pump() }

    func pump(_ times: Int = 5) { for _ in 0..<times { RunLoop.main.run(until: Date().addingTimeInterval(0.06)) } }

    // Real controls. SwiftUI materialises its own AppKit classes here with no
    // placeholder strings, so these are matched by class name and tree order.
    private func allViews() -> [NSView] {
        var out: [NSView] = []
        func walk(_ v: NSView) { out.append(v); v.subviews.forEach(walk) }
        walk(host)
        return out
    }
    private func named(_ needle: String) -> [NSControl] {
        allViews().compactMap { v in
            String(describing: Swift.type(of: v)).contains(needle) ? (v as? NSControl) : nil
        }
    }
    /// Server then Email, in Form order.
    var plainFields: [NSTextField] { named("AppKitTextField").compactMap { $0 as? NSTextField } }
    var passwordField: NSSecureTextField? { named("Secure").compactMap { $0 as? NSSecureTextField }.first }
    var toggle: NSControl? { named("Switch").first }
    var originField: NSTextField? { plainFields.count > 0 ? plainFields[0] : nil }
    var emailField: NSTextField? { plainFields.count > 1 ? plainFields[1] : nil }
    /// SwiftUI does not materialise the Connect Button in a headless render, so
    /// the button's own submit path is NOT covered here; submission is driven
    /// through the SecureField's Return / `onSubmit` instead. Recorded, not faked.
    var connectButtonMaterialised: Bool { allViews().compactMap { $0 as? NSButton }.first != nil }

    /// Type through the real field editor. Assigning `stringValue` does not travel
    /// back through SwiftUI's binding, so the view would still read empty; this
    /// is the same input path a person uses.
    func type(_ text: String, into field: NSTextField?) {
        guard let field else { return }
        window.makeFirstResponder(field)
        pump(1)
        field.currentEditor()?.insertText(text)
        pump(1)
    }

    func fillCredentials() {
        type("https://fixture.invalid", into: originField)
        type("\(name)@fixture.invalid", into: emailField)
        type("synthetic-password", into: passwordField)
    }

    func pressReturn() {
        guard let field = passwordField else { XCTFail("no password field"); return }
        window.makeFirstResponder(field)
        pump(2)
        field.currentEditor()?.insertNewline(nil)
        pump(3)
        if field.currentEditor() == nil { pump(4) }
    }

    func describeControls() -> String {
        "plain=\(plainFields.map(\.isEnabled)) secure=\(passwordField.map(\.isEnabled) ?? false) "
            + "switch=\(toggle.map(\.isEnabled) ?? false) button=\(connectButtonMaterialised)"
    }

    /// Tear the window down AND drain the shared scope. `disconnect()` alone is
    /// not enough: it cancels tasks but cannot resume the stored checked
    /// continuations, which would leak a bootstrap roster and a stream per test.
    func cleanup() async {
        close()
        await scope.finish()
        await drainScope()
    }

    private func drainScope() async {
        for _ in 0..<6 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    /// Pending waiters in both doubles, observable after teardown.
    func pendingCounts() async -> (auth: Int, transport: Int) {
        await scope.pendingCounts()
    }
}

// MARK: - Tests

@MainActor
final class SignInViewLifecycleUITests: XCTestCase {
    private func account(_ name: String) -> HarnessAccount {
        HarnessAccount(origin: "https://\(name).fixture.invalid",
                       cookieName: "better-auth.session_token",
                       cookieValue: "synthetic-\(name)")
    }
    /// Service BOTH schedulers. `beginAttempt` runs synchronously on the main
    /// actor, but the `Task` it spawns to call `authenticate` needs the main
    /// actor's executor to actually run; pumping only the run loop left that
    /// task unscheduled in this target. Alternating run-loop turns with real
    /// suspensions reliably drains both.
    private func drain(_ turns: Int = 12) async throws {
        for _ in 0..<turns {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            try await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    /// Press Return and let the Swift concurrency runtime actually schedule the
    /// coordinator's task; pumping RunLoop alone is not sufficient.
    private func submit(_ h: WindowHarness) async throws { h.pressReturn(); try await drain() }

    private func window(_ name: String, _ scope: AppScope) -> WindowHarness {
        let h = WindowHarness(name: name, scope: scope)
        addTeardownBlock { @MainActor in
            await h.cleanup()
            // BOTH doubles must be drained. Asserting only the transport let a late
            // auth continuation escape the check entirely.
            let counts = await h.pendingCounts()
            XCTAssertEqual(counts.auth, 0, "teardown left an auth continuation parked")
            XCTAssertEqual(counts.transport, 0, "teardown left a transport continuation parked")
        }
        return h
    }

    /// 1. Inputs lock while THIS window's attempt is pending.
    func testInputsLockWhileThisWindowsAttemptIsPending() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)
        XCTAssertTrue(a.emailField?.isEnabled ?? false, "precondition: editable before submit")

        try await submit(a)
        let calls = await scope.auth.calls
        XCTAssertEqual(calls, 1, "one synthetic request issued")
        XCTAssertTrue(a.signIn.isBusy)
        print("OBS lock after submit: \(a.describeControls())")

        let rebuildsBefore = a.rebuildCount
        let owningWindow = a.signIn.pendingWindow
        XCTAssertNotNil(owningWindow, "precondition: an attempt is owned by a window")
        a.rebuildRoot()   // GateView rebuild, as a publish would cause
        XCTAssertGreaterThan(a.rebuildCount, rebuildsBefore, "the rebuild must actually happen")
        XCTAssertEqual(a.signIn.pendingWindow, owningWindow,
                       "the owning window identity must survive a GateView rebuild")
        print("OBS lock after rebuild: \(a.describeControls())")
        XCTAssertFalse(a.originField?.isEnabled ?? true, "origin must lock")
        XCTAssertFalse(a.emailField?.isEnabled ?? true, "email must lock")
        XCTAssertFalse(a.passwordField?.isEnabled ?? true, "password must lock")
        XCTAssertFalse(a.toggle?.isEnabled ?? true, "mode toggle must lock")

        await scope.auth.release(account("alpha"), for: "alpha@fixture.invalid")
        try await drain()
    }

    /// 2. Duplicate Return must not start a second request.
    func testDuplicateReturnStartsOnlyOneRequest() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)

        try await submit(a)
        try await submit(a)
        try await submit(a)
        let calls = await scope.auth.calls
        let waiting = await scope.auth.waiting
        print("OBS duplicate-return calls=\(calls) waiting=\(waiting)")
        XCTAssertEqual(calls, 1, "duplicate Return must be refused")
        XCTAssertEqual(waiting, 1)

        await scope.auth.release(account("alpha"), for: "alpha@fixture.invalid")
        try await drain()
        XCTAssertEqual(scope.storage.writeCount, 1)
        XCTAssertEqual(scope.storage.storedAccount, account("alpha"))
    }

    /// 3. A then B across two real windows: B supersedes A, and the harness must
    /// actually be sharing one coordinator (asserted, not just printed).
    func testSecondWindowSupersedesFirstAndWindowsShareOneCoordinator() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)
        let b = window("beta", scope)
        XCTAssertTrue(a.live === b.live, "windows must share one LiveSessionModel")
        XCTAssertTrue(a.signIn === b.signIn, "windows must share one coordinator")

        try await submit(a)
        try await submit(b)
        let calls = await scope.auth.calls
        XCTAssertEqual(calls, 2, "each window may submit once")
        XCTAssertTrue(a.signIn.isBusy, "B now owns the attempt")

        // A answers late and must be inert.
        await scope.auth.release(account("alpha"), for: "alpha@fixture.invalid")
        try await drain()
        XCTAssertNil(scope.live.account, "the superseded window must not activate")
        XCTAssertNil(scope.storage.storedAccount, "the superseded window must not persist")
        XCTAssertTrue(a.signIn.isBusy, "B's attempt is untouched")

        await scope.auth.release(account("beta"), for: "beta@fixture.invalid")
        try await drain()
        XCTAssertEqual(scope.live.account, account("beta"))
        XCTAssertEqual(scope.storage.storedAccount, account("beta"))
        XCTAssertEqual(scope.storage.writeCount, 1)
    }

    /// 4. Closing the STALE window preserves the newer attempt.
    func testClosingStaleWindowPreservesNewerAttempt() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)
        let b = window("beta", scope)

        try await submit(a)
        try await submit(b)

        a.close()
        print("OBS after closing stale window: busy=\(a.signIn.isBusy)")
        XCTAssertTrue(a.signIn.isBusy, "closing a stale window must not cancel B")

        await scope.auth.release(account("alpha"), for: "alpha@fixture.invalid")
        try await drain()
        XCTAssertNil(scope.live.account)

        await scope.auth.release(account("beta"), for: "beta@fixture.invalid")
        try await drain()
        XCTAssertEqual(scope.live.account, account("beta"))
        XCTAssertEqual(scope.storage.storedAccount, account("beta"))
    }

    /// 5. Closing the CURRENT owner before success cancels its attempt.
    func testClosingCurrentOwnerBeforeSuccessCancelsTheAttempt() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)

        try await submit(a)
        XCTAssertTrue(a.signIn.isBusy)

        a.close()
        print("OBS after closing owner: busy=\(a.signIn.isBusy) attempt=\(a.signIn.attempt == nil ? "nil" : "present")")
        XCTAssertFalse(a.signIn.isBusy, "closing the owner must cancel its attempt")
        XCTAssertNil(a.signIn.attempt)

        await scope.auth.release(account("alpha"), for: "alpha@fixture.invalid")
        try await drain()
        XCTAssertNil(scope.storage.storedAccount, "a cancelled window must not persist credentials")
        XCTAssertNil(scope.live.account, "a cancelled window must not activate")
        XCTAssertEqual(scope.storage.deleteCount, 0, "cancelling must not delete saved credentials")
    }

    /// 6. Both response arrival orders activate only the owner.
    func testOnlyTheOwningWindowsResponseEverActivates() async throws {
        for ownerLast in [true, false] {
            let scope = AppScope()
            let alpha = "alpha\(ownerLast)", beta = "beta\(ownerLast)"
            let a = window(alpha, scope)
            let b = window(beta, scope)

            try await submit(a)
            try await submit(b)

            let stale = account(alpha), current = account(beta)
            let staleEmail = "\(alpha)@fixture.invalid", currentEmail = "\(beta)@fixture.invalid"
            if ownerLast {
                await scope.auth.release(stale, for: staleEmail)
                try await drain()
                await scope.auth.release(current, for: currentEmail)
            } else {
                await scope.auth.release(current, for: currentEmail)
                try await drain()
                await scope.auth.release(stale, for: staleEmail)
            }
            try await drain()
            print("OBS arrival ownerLast=\(ownerLast) account=\(scope.live.account?.cookieValue ?? "nil") writes=\(scope.storage.writeCount)")
            XCTAssertEqual(scope.live.account, current, "beta owns regardless of arrival order")
            XCTAssertEqual(scope.storage.writeCount, 1, "exactly one window ever persisted")
        }
    }

    /// 7. Successful navigation then disappearance keeps the user signed in.
    func testSuccessfulNavigationThenDisappearanceStaysSignedIn() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)

        try await submit(a)
        await scope.auth.release(account("alpha"), for: "alpha@fixture.invalid")
        try await drain()
        XCTAssertEqual(scope.live.account, account("alpha"), "precondition: signed in")
        XCTAssertFalse(a.signIn.isBusy, "the attempt was consumed by adoption")

        // Navigation away: GateView swaps SignInView for the live shell, so this
        // hosting view disappears exactly as it would on success.
        a.close()
        a.rebuildRoot()
        try await drain()
        print("OBS after navigation: account=\(scope.live.account?.cookieValue ?? "nil") state=\(scope.live.state)")
        XCTAssertEqual(scope.live.account, account("alpha"), "disappearance must not sign the user out")
        XCTAssertNotEqual(scope.live.state, .signedOut)
        XCTAssertEqual(scope.storage.storedAccount, account("alpha"), "credentials survive navigation")
    }

    /// 8. Window identity survives a `GateView`-style root rebuild, so the input
    /// lock and the duplicate-submit guard cannot be defeated by a publish.
    /// Reverting `@State windowID` to a plain stored default must fail this.
    func testWindowIdentitySurvivesRootRebuildSoLockAndGuardHold() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)

        try await submit(a)
        let owningWindow = a.signIn.pendingWindow
        XCTAssertNotNil(owningWindow, "precondition: an attempt is owned by a window")
        for _ in 0..<4 { a.rebuildRoot(); a.pump(2) }
        XCTAssertEqual(a.rebuildCount, 4, "the rebuilds must actually happen")
        XCTAssertEqual(a.signIn.pendingWindow, owningWindow,
                       "the owning window identity must survive GateView rebuilds")
        let calls = await scope.auth.calls
        print("OBS after 4 rebuilds: calls=\(calls) busy=\(a.signIn.isBusy) controls=\(a.describeControls())")
        XCTAssertEqual(calls, 1, "a rebuild must not be mistaken for a new window")
        XCTAssertTrue(a.signIn.isBusy)
        XCTAssertFalse(a.emailField?.isEnabled ?? true, "the lock must survive rebuilds")

        await scope.auth.release(account("alpha"), for: "alpha@fixture.invalid")
        try await drain()
        XCTAssertEqual(scope.storage.storedAccount, account("alpha"))
    }

    /// Late registration must be REFUSED, not parked.
    ///
    /// The teardown mutation above cannot catch this: a task that already passed
    /// its pre-await guard but reaches the actor after `finish()` drained would
    /// park forever, and nothing else ever resumes it. This exercises exactly
    /// that ordering.
    ///
    /// The spawned task is deliberately NOT awaited: if it parked, the pending-count
    /// assertions below have already failed cleanly, and awaiting would hang the
    /// suite instead of reporting.
    func testRegistrationAfterCloseIsRefusedRatherThanParked() async throws {
        let scope = AppScope()
        await scope.finish()
        XCTAssertFalse(scope.live.state == .live)

        let lateAuth = Task { try await scope.auth.authenticate(
            NativeSignInCoordinator.SignInInputs(origin: "https://late.fixture.invalid",
                                                  email: "late@fixture.invalid",
                                                  password: "synthetic-late", mode: .signIn)) }
        let lateRoster = Task { try await scope.transport.roster(messages: 1) }
        try await drain()

        let counts = await scope.pendingCounts()
        XCTAssertEqual(counts.auth, 0, "a late auth registration parked instead of being refused")
        XCTAssertEqual(counts.transport, 0, "a late transport registration parked instead of being refused")

        // Both should have completed with CancellationError rather than hanging.
        // Only await when nothing parked. If a continuation DID park, the
        // assertions above have already failed cleanly and awaiting would hang the
        // whole suite instead of reporting the failure.
        if counts.auth == 0, counts.transport == 0 {
            if case .success = await lateAuth.result {
                XCTFail("a refused auth registration must throw, not succeed")
            }
            if case .success = await lateRoster.result {
                XCTFail("a refused transport registration must throw, not succeed")
            }
        }
    }

    /// Two windows share one scope, so teardown runs twice per test in the
    /// multi-window cases. `finish()` must be idempotent, not a double-resume crash.
    func testCleanupIsIdempotentAcrossTwoWindowTeardowns() async throws {
        let scope = AppScope()
        let a = window("alpha", scope)
        let b = window("beta", scope)
        try await submit(a)

        await a.cleanup()
        await a.cleanup()          // same window twice
        await b.cleanup()          // second window, same shared scope
        await scope.finish()       // and the scope directly

        let counts = await scope.pendingCounts()
        XCTAssertEqual(counts.auth, 0)
        XCTAssertEqual(counts.transport, 0)
    }

    /// 9. A rejected clear preserves stored bytes — the 3191781 Keychain
    /// semantics, through the same overlay the sign-out path uses.
    func testRejectedClearPreservesStoredBytes() throws {
        let storage = InMemoryProviderStorage()
        try storage.save(account("alpha"))
        XCTAssertEqual(storage.storedAccount, account("alpha"))

        storage.deleteStatus = errSecAuthFailed
        XCTAssertThrowsError(try storage.clear(), "a rejected clear must be reported")
        XCTAssertTrue(storage.hasBytes, "rejected clear preserves the session")

        storage.deleteStatus = errSecSuccess
        try storage.clear()
        XCTAssertFalse(storage.hasBytes, "an accepted clear removes it")
    }
}