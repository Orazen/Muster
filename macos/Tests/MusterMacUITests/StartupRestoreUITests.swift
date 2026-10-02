import AppKit
import CompanionCore
import Foundation
import Security
import SwiftUI
import XCTest
@testable import MusterMac
@testable import MusterMacCore

// ============================================================================
// K1d — startup session restore.
//
// `StartupSessionRestore` is the window `.task` body extracted verbatim so it can
// be exercised without hosting the App scene. This is a MOVE, not a redesign:
// same guard, same load, same connect, same error surfaced to the same alert.
//
// Every case is fake-only. The injected `load` closure never touches the real
// Keychain, there is no network, and the transport never reaches one. No view is
// hosted and no window is ordered front.
//
// NOT proven here, and not claimed: real Keychain behaviour, real OAuth, pixels,
// the Connect Button, physical multi-window, or the alert actually appearing on
// screen. What is proven is the restore's decision logic and its effect on model
// state.
// ============================================================================

// MARK: - Fakes

/// Stands in for `SessionKeychain.load()`. Records calls so a case can prove the
/// store was never even consulted when a session already exists.
final class FakeSessionLoader: @unchecked Sendable {
    enum Result_ { case account(HarnessAccount), none, failure(Error) }
    private let lock = NSLock()
    private var result: Result_
    private(set) var callCount = 0

    init(_ result: Result_) { self.result = result }

    func load() throws -> HarnessAccount? {
        lock.lock(); callCount += 1; let r = result; lock.unlock()
        switch r {
        case let .account(a): return a
        case .none: return nil
        case let .failure(e): throw e
        }
    }
    var calls: Int { lock.lock(); defer { lock.unlock() }; return callCount }
}

/// Transport that parks the roster until released, and can be closed cleanly.
actor RestoreTransport: NativeSessionTransport {
    private var rosters: [CheckedContinuation<Fleet, Error>] = []
    private var streams: [CheckedContinuation<Void, Error>] = []
    private var isClosed = false
    private let fleet: Fleet

    init(fleet: Fleet = Fleet(bots: [], groups: [])) { self.fleet = fleet }

    func roster(messages: Int) async throws -> Fleet {
        if isClosed { throw CancellationError() }
        return try await withCheckedThrowingContinuation { c in rosters.append(c) }
    }
    func releaseRoster() { if !rosters.isEmpty { rosters.removeFirst().resume(returning: fleet) } }
    func memory(botId: String) async throws -> String { "synthetic" }
    func send(text: String, to botId: String, clientIntentId: String) async throws -> SendReceipt {
        SendReceipt(intentId: clientIntentId, messageId: "m", threadId: "t", state: "accepted")
    }
    func respond(botId: String, requestId: String, behavior: String, message: String?) async throws -> MusterMacCore.ApprovalOutcome {
        try JSONDecoder().decode(MusterMacCore.ApprovalOutcome.self, from: Data(#"{"ok":true}"#.utf8))
    }
    func events(lastEventId: String?, onEvent: @escaping @Sendable (StreamFrame) -> Void,
                onHello: @escaping @Sendable (String, Bool) -> Void) async throws {
        if isClosed { throw CancellationError() }
        return try await withCheckedThrowingContinuation { c in streams.append(c) }
    }
    @discardableResult
    func finish() -> Int {
        isClosed = true
        let n = rosters.count + streams.count
        for c in rosters { c.resume(throwing: CancellationError()) }; rosters = []
        for c in streams { c.resume(throwing: CancellationError()) }; streams = []
        return n
    }
    func inFlight() -> Int { rosters.count + streams.count }
}

// MARK: - Tests

@MainActor
final class StartupRestoreUITests: XCTestCase {
    private func saved() -> HarnessAccount {
        HarnessAccount(origin: "https://saved.fixture.invalid",
                       cookieName: "better-auth.session_token", cookieValue: "synthetic-saved")
    }
    private func drain(_ turns: Int = 8) async throws {
        for _ in 0..<turns {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            try await Task.sleep(nanoseconds: 3_000_000)
        }
    }
    /// Wait until the held authenticator has ACTUALLY parked a continuation.
    ///
    /// `isBusy` is not a substitute: the coordinator sets it synchronously in
    /// `beginAttempt`, before its spawned task ever reaches the auth actor. Only a
    /// registration count proves the request is real and deliverable.
    private func waitForRegistrations(_ auth: RestoreAuth, atLeast n: Int = 1,
                                      file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(3)
        while await auth.registrations < n && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            try await Task.sleep(nanoseconds: 3_000_000)
        }
        let seen = await auth.registrations
        XCTAssertGreaterThanOrEqual(seen, n,
                                    "expected the authenticator to park \(n) continuation(s); it parked \(seen)",
                                    file: file, line: line)
    }

    private func makeLive() -> (LiveSessionModel, RestoreTransport) {
        let transport = RestoreTransport()
        let live = LiveSessionModel(transportFactory: { _ in transport })
        addTeardownBlock { @MainActor in
            live.disconnect()
            await transport.finish()
            let left = await transport.inFlight()
            XCTAssertEqual(left, 0, "teardown left a continuation parked")
        }
        return (live, transport)
    }

    /// 1. Nothing stored: restore is a no-op and the app stays signed out.
    func testNoStoredRecordLeavesTheAppSignedOut() async throws {
        let (live, _) = makeLive()
        let loader = FakeSessionLoader(.none)

        let outcome = StartupSessionRestore.run(live: live, load: loader.load)
        try await drain()

        XCTAssertEqual(outcome, .nothingStored)
        XCTAssertEqual(live.state, .signedOut, "a signed-out app must stay signed out")
        XCTAssertNil(live.account, "no session may be invented")
        XCTAssertEqual(loader.calls, 1, "the store is consulted exactly once")
    }

    /// 2. A session already exists: restore is SKIPPED, and the store is never
    ///    even consulted — it must not overwrite a live session.
    func testExistingConnectedStateSkipsRestoreWithoutTouchingTheStore() async throws {
        let (live, transport) = makeLive()
        live.connect(account: saved())
        // Let the bootstrap actually register its roster continuation before
        // releasing it, otherwise there is nothing to release.
        try await drain(4)
        await transport.releaseRoster()
        try await drain(10)
        XCTAssertEqual(live.state, .live, "precondition: a session is already established")

        let loader = FakeSessionLoader(.account(
            HarnessAccount(origin: "https://other.fixture.invalid",
                           cookieName: "c", cookieValue: "synthetic-other")))

        let outcome = StartupSessionRestore.run(live: live, load: loader.load)
        try await drain()

        XCTAssertEqual(outcome, .skippedAlreadyActive)
        XCTAssertEqual(loader.calls, 0, "an existing session must not be replaced by a stored one")
        XCTAssertEqual(live.account, saved(), "the established session survives untouched")
        XCTAssertEqual(live.state, .live)
    }

    /// 3. A load failure is surfaced, not swallowed, and leaves state alone.
    func testLoadFailureIsSurfacedAndLeavesTheAppSignedOut() async throws {
        let (live, _) = makeLive()
        let loader = FakeSessionLoader(.failure(SessionKeychainError.loadFailed(errSecInteractionNotAllowed)))

        let outcome = StartupSessionRestore.run(live: live, load: loader.load)
        try await drain()

        guard case let .failed(message) = outcome else {
            return XCTFail("a failed load must be reported, got \(outcome)")
        }
        // The message is what the window surfaces in its "Could not restore
        // sign-in" alert; assert the real measured text, not a paraphrase.
        XCTAssertTrue(message.contains("\(errSecInteractionNotAllowed)"),
                      "the measured status must reach the user: \(message)")
        XCTAssertEqual(live.state, .signedOut, "a failed load must not sign anyone in")
        XCTAssertNil(live.account)
    }

    /// 4. A stored account is restored and connected.
    func testSavedAccountIsRestoredAndConnected() async throws {
        let (live, _) = makeLive()
        let loader = FakeSessionLoader(.account(saved()))

        let outcome = StartupSessionRestore.run(live: live, load: loader.load)
        try await drain()

        XCTAssertEqual(outcome, .restored(saved()))
        XCTAssertEqual(live.account, saved(), "the stored account becomes the active session")
        XCTAssertNotEqual(live.state, .signedOut)
    }

    /// 5. Restoring supersedes a sign-in that is still in flight, and a late
    ///    response for it is PROVABLY DELIVERED and still does nothing.
    ///
    ///    The delivery proof is the point. The previous version of this case used
    ///    `signIn.isBusy` as its only evidence that a request existed, and a fake
    ///    whose `release` silently no-opped — so every "a late response must not
    ///    take effect" assertion could pass without a response ever arriving. Now
    ///    the fake counts registrations and resumes, the test waits for the
    ///    registration, and `release` reports whether it resumed anything.
    func testRestoreSupersedesAPendingSignInAndTheLateResponseIsActuallyDelivered() async throws {
        let (live, _) = makeLive()
        let overlay = RestoreStorage()
        let auth = RestoreAuth()
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { try await auth.authenticate($0) },
            saveAccount: { try SessionKeychain.save($0, storage: overlay) }
        )
        live.onSessionWillChangeExternally = { [weak signIn] in signIn?.invalidateForExternalSessionChange() }
        addTeardownBlock { @MainActor in
            signIn.invalidateForShutdown()
            let drained = await auth.finish()   // close + drain, counted
            let left = await auth.inFlight
            XCTAssertEqual(left, 0, "teardown left an auth continuation parked")
            XCTAssertEqual(drained, 0, "nothing should still be parked at teardown; the response was consumed")

            // Cancellation alone does not resume a checked continuation, so a
            // request that arrives after close must be REFUSED, not parked forever.
            // Prove the close is real rather than asserting it by inspection.
            let refusedBefore = await auth.refusedAfterClose
            do {
                _ = try await auth.authenticate(.init(
                    origin: "https://late.fixture.invalid", email: "late@fixture.invalid",
                    password: "synthetic", mode: .signIn))
                XCTFail("authentication after close must be refused, not accepted")
            } catch {
                let refusedAfter = await auth.refusedAfterClose
                print("OBS case5 teardown drained=\(drained) refusedAfterClose=\(refusedAfter - refusedBefore)")
                XCTAssertEqual(refusedAfter - refusedBefore, 1,
                               "the post-close registration must be refused and counted")
            }
            // Hoisted: `await` inside an XCTAssert autoclosure does not compile.
            let stillParked = await auth.inFlight
            XCTAssertEqual(stillParked, 0, "a refused registration must not be parked")
        }

        // A sign-in is submitted.
        signIn.beginAttempt(window: UUID(), inputs: .init(
            origin: "https://typed.fixture.invalid", email: "typed@fixture.invalid",
            password: "synthetic", mode: .signIn))

        // PROVEN registration, not inferred from isBusy.
        try await waitForRegistrations(auth, atLeast: 1)
        XCTAssertTrue(signIn.isBusy)
        let parked = await auth.inFlight
        XCTAssertEqual(parked, 1, "exactly one request must be deliverable")

        // Startup restore runs and wins.
        let loader = FakeSessionLoader(.account(saved()))
        let outcome = StartupSessionRestore.run(live: live, load: loader.load)
        try await drain()

        XCTAssertEqual(outcome, .restored(saved()))
        XCTAssertEqual(live.account, saved())
        // Model level, not just the flag: the attempt object itself is gone.
        XCTAssertNil(signIn.attempt, "restore must supersede the pending sign-in attempt")
        XCTAssertFalse(signIn.isBusy, "restore must clear the superseded attempt")

        // Deliver the late response. This MUST resume something, or the test fails
        // here rather than passing vacuously further down.
        let delivered = await auth.release(HarnessAccount(origin: "https://typed.fixture.invalid",
                                                         cookieName: "c", cookieValue: "synthetic-typed"))
        XCTAssertTrue(delivered, "the late response must actually be delivered, not silently dropped")
        let resumes = await auth.resumes
        let registrations = await auth.registrations
        print("OBS case5 registrations=\(registrations) resumes=\(resumes) delivered=\(delivered)")
        XCTAssertEqual(resumes, 1, "exactly one late response may be resumed")
        try await drain()

        // And now the behaviour under test: the delivered response changed nothing.
        XCTAssertEqual(live.account, saved(), "a delivered late response must not replace the restored session")
        XCTAssertFalse(overlay.hasStoredBytes, "and must not persist over it")
    }
}

// MARK: - Small doubles used only by case 5

final class RestoreStorage: SessionKeychainStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Data?
    func add(_ a: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        guard bytes == nil else { return errSecDuplicateItem }
        bytes = a[kSecValueData as String] as? Data
        return errSecSuccess
    }
    func update(_ q: [String: Any], attributes a: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        guard bytes != nil else { return errSecItemNotFound }
        bytes = a[kSecValueData as String] as? Data
        return errSecSuccess
    }
    func read(_ q: [String: Any]) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        return bytes.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
    }
    func delete(_ q: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }; bytes = nil; return errSecSuccess
    }
    var hasStoredBytes: Bool { lock.lock(); defer { lock.unlock() }; return bytes != nil }
}

/// Held synthetic authentication with OBSERVABLE bookkeeping.
///
/// The earlier version of this double silently did nothing when there was no
/// pending continuation, so a case could assert "a late response did not take
/// effect" without ever having delivered one. `isBusy` was the only proxy for
/// "the request actually started", and that is not evidence: the coordinator sets
/// `isBusy` synchronously, before its task ever reaches this actor.
///
/// So: registration is counted, release REPORTS whether it resumed anything, and
/// the actor closes so late registrations are refused rather than parked.
actor RestoreAuth {
    private var pending: [CheckedContinuation<HarnessAccount, Error>] = []
    private var isClosed = false

    /// Continuations actually parked in this actor. Proves the request entered.
    private(set) var registrations = 0
    /// Continuations actually resumed, whether by release or by close.
    private(set) var resumes = 0
    /// Registrations refused because the actor was already closed.
    private(set) var refusedAfterClose = 0

    func authenticate(_ inputs: NativeSignInCoordinator.SignInInputs) async throws -> HarnessAccount {
        if isClosed {
            refusedAfterClose += 1
            throw CancellationError()
        }
        return try await withCheckedThrowingContinuation { c in
            if isClosed {
                refusedAfterClose += 1
                c.resume(throwing: CancellationError())
                return
            }
            pending.append(c)
            registrations += 1
        }
    }

    var inFlight: Int { pending.count }

    /// Resumes one parked continuation. Returns whether it actually resumed one,
    /// so a caller can never mistake a silent no-op for a delivered response.
    @discardableResult
    func release(_ account: HarnessAccount) -> Bool {
        guard !isClosed, !pending.isEmpty else { return false }
        pending.removeFirst().resume(returning: account)
        resumes += 1
        return true
    }

    /// Close and drain. Returns how many were drained.
    @discardableResult
    func finish() -> Int {
        isClosed = true
        let n = pending.count
        for c in pending { c.resume(throwing: CancellationError()) }
        resumes += n
        pending = []
        return n
    }
}