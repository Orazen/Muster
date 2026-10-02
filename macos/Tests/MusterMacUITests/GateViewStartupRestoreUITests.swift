import AppKit
import CompanionCore
import Foundation
import Security
import SwiftUI
import XCTest
@testable import MusterMac
@testable import MusterMacCore

// ============================================================================
// K1c — GateView routing regression.
//
// `GateView` is the gate the whole app hangs off: it switches on `live.state`
// and chooses which surface the user sees. Nothing executed it before this file.
//
// Red first: `LegacyFlatGate` below is a transcription of a gate that renders the
// sign-in form unconditionally — the shape an app has before any routing. It is
// a TEST-ONLY helper with the defect written into its body, i.e. a negative
// control. It is NOT a reproduction of a shipped defect, and must not be cited as
// one. The routing cases then run against the real `GateView`.
//
// Substitutions, and only these: authentication is refused outright (no server, no
// OAuth, no token) and protected storage is an in-memory overlay driving the real
// `SessionKeychain` logic through its internal `storage:` seam.
//
// NOT proven here: physical multi-window behaviour, real OAuth, real Keychain,
// installed app, or the Connect Button's own submit path. Headless SwiftUI was
// separately observed to crash (signal 11) when a window is ordered front, so no
// test in this file tries. The human Mac gate remains open.
// ============================================================================

// MARK: - Doubles

final class RoutingStorage: SessionKeychainStorage, @unchecked Sendable {
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
    func save(_ a: HarnessAccount) throws { try SessionKeychain.save(a, storage: self) }
}

/// Transport that answers a roster immediately, so the live shell can be reached.
actor RosterTransport: NativeSessionTransport {
    private let fleet: Fleet
    private var streams: [CheckedContinuation<Void, Error>] = []
    private var rosters: [CheckedContinuation<Fleet, Error>] = []
    private(set) var rosterCalls = 0
    private var isClosed = false
    /// Park the roster instead of answering, so `.connecting` is observable.
    let parksRoster: Bool
    init(_ fleet: Fleet, parksRoster: Bool = false) {
        self.fleet = fleet
        self.parksRoster = parksRoster
    }

    func roster(messages: Int) async throws -> Fleet {
        if isClosed { throw CancellationError() }
        rosterCalls += 1
        if parksRoster {
            return try await withCheckedThrowingContinuation { c in
                if isClosed { c.resume(throwing: CancellationError()); return }
                rosters.append(c)
            }
        }
        return fleet
    }
    func releaseRoster() {
        guard !rosters.isEmpty else { return }
        rosters.removeFirst().resume(returning: fleet)
    }
    /// End the stream normally, which is what drives the model into `.degraded`.
    func dropStream() {
        guard !streams.isEmpty else { return }
        streams.removeFirst().resume()
    }
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
        return try await withCheckedThrowingContinuation { c in
            if isClosed { c.resume(throwing: CancellationError()); return }
            streams.append(c)
        }
    }
    @discardableResult
    func finish() -> Int {
        isClosed = true
        let n = streams.count + rosters.count
        for c in streams { c.resume(throwing: CancellationError()) }
        for c in rosters { c.resume(throwing: CancellationError()) }
        streams = []
        rosters = []
        return n
    }
    func inFlight() -> Int { streams.count + rosters.count }
}

@MainActor
final class RoutingScope {
    let live: LiveSessionModel
    let signIn: NativeSignInCoordinator
    let storage: RoutingStorage
    let transport: RosterTransport
    init(fleet: Fleet, parksRoster: Bool = false) {
        let transport = RosterTransport(fleet, parksRoster: parksRoster)
        let storage = RoutingStorage()
        let live = LiveSessionModel(transportFactory: { _ in transport })
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { _ in throw URLError(.unsupportedURL) },
            saveAccount: { try storage.save($0) }
        )
        live.onSessionWillChangeExternally = { [weak signIn] in signIn?.invalidateForExternalSessionChange() }
        self.storage = storage
        self.transport = transport
        self.live = live
        self.signIn = signIn
    }
    func finish() async {
        live.disconnect()
        await transport.finish()
        live.disconnect()
    }
    func pendingTransport() async -> Int { await transport.inFlight() }
    func releaseRoster() async { await transport.releaseRoster() }
}

/// TEST-ONLY negative control: a gate with no routing at all. Its defect is in its
/// own body; it is not a reproduction of anything shipped.
@MainActor
final class LegacyFlatGate {
    let live: LiveSessionModel
    init(live: LiveSessionModel) { self.live = live }
    /// Always the sign-in form, whatever the session is doing.
    var renderedSurface: String { "sign-in" }
}

// MARK: - Rendering helpers

@MainActor
enum Surface {
    /// What the hosted view tree actually shows, read off real controls.
    static func controls(_ root: NSView) -> [String] {
        var out: [String] = []
        func walk(_ v: NSView) {
            if let c = v as? NSControl {
                out.append(String(describing: Swift.type(of: c)).lowercased())
            }
            v.subviews.forEach(walk)
        }
        walk(root)
        return out
    }
    static func has(_ kinds: [String], _ needle: String) -> Bool {
        kinds.contains { $0.contains(needle) }
    }
    /// A sign-in form is identifiable by its password field.
    static func showsSignInForm(_ kinds: [String]) -> Bool { has(kinds, "secure") }

    // Positive, PUBLIC-AppKit markers. Chosen so that rendering nothing at all
    // cannot satisfy them, which is what the previous negative-only assertions
    // allowed. No SwiftUI-internal class names are used here.
    /// The live shell's sidebar `.searchable` — an `NSSearchField`. Only the live
    /// shell has one; the sign-in form and the connecting view have none.
    static func searchFields(_ root: NSView) -> [NSSearchField] {
        var out: [NSSearchField] = []
        func walk(_ v: NSView) { if let s = v as? NSSearchField { out.append(s) }; v.subviews.forEach(walk) }
        walk(root)
        return out
    }
    /// A spinner. Present in `.degraded` (reconnecting) and absent in a settled
    /// `.live` session, which is what separates the two positive cases.
    static func progressIndicators(_ root: NSView) -> [NSProgressIndicator] {
        var out: [NSProgressIndicator] = []
        func walk(_ v: NSView) { if let p = v as? NSProgressIndicator { out.append(p) }; v.subviews.forEach(walk) }
        walk(root)
        return out
    }
    /// Every string the rendered tree actually presents. SwiftUI labels expose
    /// their text through `attributedStringValue`, not always `stringValue`, so
    /// both are read rather than assuming one.
    static func texts(_ root: NSView) -> [String] {
        var out: [String] = []
        func walk(_ v: NSView) {
            if let t = v as? NSTextField {
                if !t.stringValue.isEmpty { out.append(t.stringValue) }
                let a = t.attributedStringValue.string
                if !a.isEmpty { out.append(a) }
                if let ph = t.placeholderString, !ph.isEmpty { out.append(ph) }
            }
            if let l = v as? NSTextFieldCell { let s = l.stringValue; if !s.isEmpty { out.append(s) } }
            v.subviews.forEach(walk)
        }
        walk(root)
        return Array(Set(out))
    }
}

// MARK: - Negative control

@MainActor
final class GateRoutingNegativeControlTests: XCTestCase {
    /// NEGATIVE CONTROL, not reproduction. Shows what routing prevents.
    func testNegativeControlFlatGateIgnoresSessionState() {
        let transport = RosterTransport(Fleet(bots: [], groups: []))
        let live = LiveSessionModel(transportFactory: { _ in transport })
        let flat = LegacyFlatGate(live: live)

        live.connect(account: HarnessAccount(origin: "https://x.fixture.invalid",
                                             cookieName: "c", cookieValue: "v"))

        XCTAssertEqual(flat.renderedSurface, "sign-in",
                       "DEFECT: a flat gate keeps showing sign-in even when a session is live")
        live.disconnect()
    }
}

// MARK: - The real gate

@MainActor
final class GateViewRoutingTests: XCTestCase {
    private func fleet() -> Fleet {
        let sample = FixtureFleet.standard()
        var bot = sample.fleet.bots[0]
        bot.messages = sample.transcript
        return Fleet(bots: [bot], groups: [])
    }
    private func account() -> HarnessAccount {
        HarnessAccount(origin: "https://session.fixture.invalid",
                       cookieName: "better-auth.session_token", cookieValue: "synthetic-session")
    }
    private func drain(_ turns: Int = 10) async throws {
        for _ in 0..<turns {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            try await Task.sleep(nanoseconds: 4_000_000)
        }
    }
    /// Tear a hosted window down WITHOUT closing it.
    ///
    /// Measured, not assumed: calling `NSWindow.close()` on a hosting view that
    /// was never ordered front **crashes the test process with signal 11** in
    /// this headless harness. Detaching the content view achieves the same
    /// teardown safely, which is why the existing sign-in lifecycle target does
    /// exactly this. Do not "simplify" this back to `close()`.
    private func detach(_ w: NSWindow) {
        w.contentView = NSView(frame: .zero)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    private func host(_ view: some View) -> (NSHostingView<AnyView>, NSWindow) {
        let h = NSHostingView(rootView: AnyView(view))
        h.frame = .init(x: 0, y: 0, width: 1100, height: 760)
        let w = NSWindow(contentRect: h.frame, styleMask: [.titled, .resizable],
                         backing: .buffered, defer: false)
        w.contentView = h
        return (h, w)
    }
    private func makeScope() -> RoutingScope {
        let scope = RoutingScope(fleet: fleet())
        addTeardownBlock { @MainActor in
            await scope.finish()
            let left = await scope.pendingTransport()
            XCTAssertEqual(left, 0, "teardown left a transport continuation parked")
        }
        return scope
    }

    /// 1. A signed-out session routes to the sign-in form.
    func testSignedOutRoutesToTheSignInForm() async throws {
        let scope = makeScope()
        let (h, w) = host(GateView().environmentObject(scope.live)
            .environmentObject(scope.signIn)
            .environmentObject(PrototypeModel.fixture()))
        try await drain()
        let kinds = Surface.controls(h)
        print("OBS signedOut kinds=\(Set(kinds).sorted())")
        XCTAssertEqual(scope.live.state, .signedOut, "precondition")
        XCTAssertTrue(Surface.showsSignInForm(kinds), "a signed-out session must show the sign-in form")
        detach(w)
    }

    /// 2. A live session routes AWAY from the sign-in form.
    func testLiveRoutesAwayFromTheSignInForm() async throws {
        let scope = makeScope()
        scope.live.connect(account: account())
        try await drain()
        let (h, w) = host(GateView().environmentObject(scope.live)
            .environmentObject(scope.signIn)
            .environmentObject(PrototypeModel.fixture()))
        try await drain()
        let kinds = Surface.controls(h)
        print("OBS live kinds=\(Set(kinds).sorted())")
        XCTAssertEqual(scope.live.state, .live, "precondition")
        XCTAssertFalse(Surface.showsSignInForm(kinds),
                       "a live session must not keep showing the sign-in form")
        // POSITIVE evidence, not merely the absence of the form: the live shell
        // positively presents its sidebar search field. An empty view cannot
        // satisfy this, which the previous negative-only assertion allowed.
        let searchFields = Surface.searchFields(h)
        print("OBS live searchFields=\(searchFields.count) progress=\(Surface.progressIndicators(h).count)")
        XCTAssertFalse(searchFields.isEmpty,
                       "a live session must positively render the shell, not merely hide the form")
        XCTAssertTrue(Surface.progressIndicators(h).isEmpty,
                      "a settled live session shows no reconnect spinner")
        detach(w)
    }

    /// 4. A failed session routes back to the sign-in form AND carries the reason.
    ///
    /// Reaching `.failed` requires the transport factory itself to refuse, which is
    /// what the app does for an address it cannot build a client for. G2 (dropping
    /// `initialError:`) survived until this case existed, so the message path was
    /// previously unpinned.
    func testFailedRouteShowsSignInFormCarryingTheReason() async throws {
        let transport = RosterTransport(fleet())
        let live = LiveSessionModel(transportFactory: { _ in throw URLError(.badURL) })
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { _ in throw URLError(.unsupportedURL) },
            saveAccount: { _ in throw URLError(.unsupportedURL) })
        addTeardownBlock { @MainActor in
            live.disconnect()
            await transport.finish()
            let left = await transport.inFlight()
            XCTAssertEqual(left, 0, "teardown left a transport continuation parked")
        }

        live.connect(account: account())
        try await drain(2)
        guard case let .failed(reason) = live.state else {
            return XCTFail("precondition: expected a failed session, got \(live.state)")
        }

        let (h, w) = host(GateView().environmentObject(live)
            .environmentObject(signIn)
            .environmentObject(PrototypeModel.fixture()))
        try await drain()
        let kinds = Surface.controls(h)
        let texts = Surface.texts(h)
        let surfaced = signIn.errorMessage
        print("OBS failed kinds=\(Set(kinds).sorted()) texts=\(texts) errorMessage=\(surfaced ?? "nil") reason=\(reason)")
        XCTAssertTrue(Surface.showsSignInForm(kinds), "a failed session must offer sign-in again")
        // The reason provably REACHES the sign-in surface. Whether SwiftUI then
        // *draws* it is NOT verified here and not claimed: a `Text` inside a grouped
        // `Form` does not surface as a scrapable NSTextField in a headless render.
        // Scraping the label text is therefore an unreliable signal, and asserting
        // on it produced a false failure. The route contract is what is pinned.
        XCTAssertEqual(surfaced, reason,
                       "the failure reason must reach the sign-in surface, not be dropped")
        detach(w)
    }

    /// 5. A connecting session shows neither the sign-in form nor a settled shell.
    func testConnectingRouteIsNeitherSignInNorSettledShell() async throws {
        let transport = RosterTransport(fleet(), parksRoster: true)
        let live = LiveSessionModel(transportFactory: { _ in transport })
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { _ in throw URLError(.unsupportedURL) },
            saveAccount: { _ in throw URLError(.unsupportedURL) })
        addTeardownBlock { @MainActor in
            await transport.finish()
            live.disconnect()
            let left = await transport.inFlight()
            XCTAssertEqual(left, 0, "teardown left a transport continuation parked")
        }

        live.connect(account: account())
        try await drain(4)
        XCTAssertEqual(live.state, .connecting, "precondition: the roster is parked")

        let (h, w) = host(GateView().environmentObject(live)
            .environmentObject(signIn)
            .environmentObject(PrototypeModel.fixture()))
        try await drain()
        let kinds = Surface.controls(h)
        let searchFields = Surface.searchFields(h)
        let progress = Surface.progressIndicators(h)
        print("OBS connecting kinds=\(Set(kinds).sorted()) searchFields=\(searchFields.count) progress=\(progress.count)")
        XCTAssertFalse(Surface.showsSignInForm(kinds),
                       "while connecting, the sign-in form must not be offered again")
        XCTAssertTrue(searchFields.isEmpty,
                      "and the live shell must not appear before the session is ready")

        // HONEST NARROWING, measured not assumed. `ConnectingView` renders only a
        // Flower plus a `Text("Connecting…")`, and a headless probe shows it
        // exposes ZERO NSControls, zero search fields, zero progress indicators and
        // zero readable strings. There is therefore NO reliable accessible marker
        // for this route. What is pinned here is only that the connecting route is
        // distinguishable from BOTH other surfaces. Positively identifying the
        // connecting view needs a windowed/device gate and is NOT claimed.
        detach(w)
    }

    /// 6. A degraded session still shows the live shell, AND shows a reconnect
    ///    spinner that a settled session does not.
    ///
    ///    Reached the way the app reaches it: connect, let the roster land, then
    ///    end the stream. Headless markers observed: `.live` presents 1
    ///    `NSSearchField` and 0 `NSProgressIndicator`; `.degraded` presents 1 of
    ///    each. The spinner is what makes this case positively distinguishable from
    ///    `.live` rather than merely "also renders a shell".
    func testDegradedRouteShowsTheShellWithAReconnectSpinner() async throws {
        let transport = RosterTransport(fleet())
        let live = LiveSessionModel(transportFactory: { _ in transport })
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { _ in throw URLError(.unsupportedURL) },
            saveAccount: { _ in throw URLError(.unsupportedURL) })
        addTeardownBlock { @MainActor in
            await transport.finish()
            live.disconnect()
            let left = await transport.inFlight()
            XCTAssertEqual(left, 0, "teardown left a transport continuation parked")
        }

        live.connect(account: account())
        await transport.releaseRoster()
        try await drain(10)
        XCTAssertEqual(live.state, .live, "precondition: the roster landed")

        await transport.dropStream()
        try await drain(10)
        guard case .degraded = live.state else {
            return XCTFail("precondition: expected a degraded session, got \(live.state)")
        }

        let (h, w) = host(GateView().environmentObject(live)
            .environmentObject(signIn)
            .environmentObject(PrototypeModel.fixture()))
        try await drain()
        let searchFields = Surface.searchFields(h)
        let progress = Surface.progressIndicators(h)
        print("OBS degraded searchFields=\(searchFields.count) progress=\(progress.count)")
        XCTAssertFalse(searchFields.isEmpty,
                       "a degraded session must keep showing the shell, not fall back to sign-in")
        XCTAssertFalse(progress.isEmpty,
                       "a degraded session must positively show a reconnect indicator")
        detach(w)
    }

    /// 3. Routing follows `live.state`, not the order operations happened in.
    func testRoutingFollowsStateNotHistory() async throws {
        let scope = makeScope()
        let (h, w) = host(GateView().environmentObject(scope.live)
            .environmentObject(scope.signIn)
            .environmentObject(PrototypeModel.fixture()))
        try await drain()
        XCTAssertTrue(Surface.showsSignInForm(Surface.controls(h)), "precondition: signed out")

        scope.live.connect(account: account())
        try await drain()
        XCTAssertFalse(Surface.showsSignInForm(Surface.controls(h)),
                       "the same hosted gate must switch surface once a session exists")

        scope.live.disconnect()
        try await drain()
        XCTAssertTrue(Surface.showsSignInForm(Surface.controls(h)),
                      "and switch back when the session ends")
        detach(w)
    }
}