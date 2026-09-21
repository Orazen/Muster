import CompanionCore
import XCTest

private final class OwnedWatchRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class ForegroundCallAcceptance: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "com.muster.companion.watchkitapp")

    override func setUp() { continueAfterFailure = false }

    func capture(_ name: String) {
        let picture = XCTAttachment(screenshot: app.screenshot())
        picture.name = name; picture.lifetime = .keepAlways; add(picture)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-hierarchy"; tree.lifetime = .keepAlways; add(tree)
    }

    func reveal(_ identifier: String) throws -> XCUIElement {
        let element = app.descendants(matching: .any)[identifier].firstMatch
        let isCall = identifier.hasPrefix("watch-call-") || identifier.hasPrefix("watch-calendar-")
        // The chat face is a ScrollView (like the call screen), not a List;
        // its composer and reply bubble must be sought in scrollViews. The
        // fleet roster rows (watch-chat-bot-*) are List rows and stay in
        // collectionViews — only the in-chat identifiers are chat-screen.
        let isChat = identifier == "watch-chat-reply" || identifier.hasPrefix("watch-composer-")
            || identifier == "watch-streaming-bubble" || identifier == "watch-thinking"
        let isScrollScreen = isCall || isChat || identifier == "watch-open-call"
        let container = isScrollScreen ? app.scrollViews.firstMatch : app.collectionViews.firstMatch
        let top = isCall ? 52.0 : 65.0
        // Scroll drags must ride the screen edge: a centered drag lands on
        // tappable content (bubbles, the Reply field) and activates it
        // instead of scrolling — the exact trap the call screen avoided.
        let dragX = isScrollScreen ? 0.98 : 0.5
        guard container.waitForExistence(timeout: 10) else { throw NSError(domain: "OwnedWatchMissingScrollContainer", code: 1) }
        for index in 0..<6 {
            // A keyboard left open from a previous step swallows swipes and
            // hides the lower half of the screen; dismiss it rather than
            // fail — the caller that needs the keyboard uses enter().
            let doneButton = app.buttons["Done"].firstMatch
            if doneButton.exists {
                doneButton.tap()
                for _ in 0..<10 where doneButton.exists {
                    usleep(200_000)
                }
            }
            print("Owned reveal \(identifier) step \(index): \(element.exists ? String(describing: element.frame) : "absent")")
            if element.exists {
                let frame = element.frame
                // Bar-pinned controls live above any content bound by design.
                if identifier == "watch-open-call" { return element }
                if frame.minY >= top && frame.maxY <= app.frame.maxY - 4 { return element }
            }
            if index == 0 { capture("before-scroll-" + identifier) }
            // Full watch swipes overshoot this compact list. Follow the observed
            // target frame with a short drag inside the actual scroll container.
            let above = ["watch-pairing-code", "watch-pairing-submit", "watch-call-status", "watch-call-end", "watch-call-input"].contains(identifier)
            let downward = element.exists ? element.frame.minY < top : above
            let start = container.coordinate(withNormalizedOffset: CGVector(dx: dragX, dy: downward ? 0.45 : 0.75))
            let finish = container.coordinate(withNormalizedOffset: CGVector(dx: dragX, dy: downward ? 0.75 : 0.45))
            start.press(forDuration: 0.1, thenDragTo: finish, withVelocity: .slow, thenHoldForDuration: 0.2)
            if index == 0 { capture("after-scroll-" + identifier) }
        }
        if element.exists && element.frame.minY >= top && element.frame.maxY <= app.frame.maxY - 4 { return element }
        capture("unreachable-" + identifier)
        throw NSError(domain: "OwnedWatchUnreachable-" + identifier, code: 1)
    }

    func tap(_ identifier: String) throws {
        let element = try reveal(identifier)
        guard element.isEnabled else { throw NSError(domain: "OwnedWatchDisabled-" + identifier, code: 1) }
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    func enter(_ identifier: String, _ value: String) throws {
        // Reveal without the keyboard dance first: reveal() dismisses any
        // keyboard, then we tap the field to summon the editor deliberately.
        _ = try reveal(identifier)
        try tap(identifier)
        let done = app.buttons["Done"].firstMatch
        if !done.waitForExistence(timeout: 5) {
            // A cold Watch can ignore the first tap while the editor starts.
            // Only retry the observed field when no editor appeared; never type
            // into the application before its system keyboard is visible.
            capture("editor-not-open-" + identifier)
            try tap(identifier)
        }
        guard done.waitForExistence(timeout: 10) else { throw NSError(domain: "OwnedWatchKeyboardDone", code: 1) }
        app.typeText(value)
        done.tap()
    }

    func origin(_ key: String) throws -> URL {
        let value = try XCTUnwrap(ProcessInfo.processInfo.environment[key])
        let url = try XCTUnwrap(URL(string: value))
        guard url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw NSError(domain: "OwnedWatch", code: 1) }
        return url
    }

    /// Pairs the simulator unless the fleet is already up (XCTest runs this
    /// suite alphabetically, so the chat test pairs first on a shared run).
    /// Returns an ephemeral session for control-plane calls.
    ///
    /// The paired check is the mascot itself, waited on generously: a cold
    /// Release build on a fresh simulator can take well over five seconds to
    /// render its first frame, and a too-eager "already paired" conclusion
    /// leaves the test staring at PairingView forever.
    @discardableResult
    func pairIfNeeded(control: URL, companion: URL) throws -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        let network = URLSession(configuration: config, delegate: OwnedWatchRedirectPolicy(), delegateQueue: nil)
        if app.descendants(matching: .any)["watch-fleet-mascot"].firstMatch.waitForExistence(timeout: 30) {
            return network
        }
        // The pairing screen's always-materialized row is the code field;
        // the manual-address section sits below the fold and SwiftUI's List
        // does not materialize it until something scrolls — reveal()'s drags
        // do that, a plain existence wait never will.
        guard app.descendants(matching: .any)["watch-pairing-code"].firstMatch.waitForExistence(timeout: 30) else {
            capture("neither-fleet-nor-pairing")
            throw NSError(domain: "OwnedWatchNeitherFleetNorPairing", code: 1)
        }
        try enter("pairing-address-input", companion.absoluteString)
        try tap("watch-use-address")
        var request = URLRequest(url: control.appendingPathComponent("pairing")); request.httpMethod = "POST"
        let semaphore = DispatchSemaphore(value: 0)
        var payload: Data?, response: URLResponse?, failure: Error?
        network.dataTask(with: request) { data, urlResponse, error in
            payload = data; response = urlResponse; failure = error; semaphore.signal()
        }.resume()
        semaphore.wait()
        if let failure { throw failure }
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        struct Pairing: Decodable { let code: String }
        let code = try JSONDecoder().decode(Pairing.self, from: XCTUnwrap(payload)).code
        try enter("watch-pairing-code", code)
        try tap("watch-pairing-submit")
        return network
    }

    func testExplicitForegroundCall() async throws {
        let companion = try origin("MUSTER_WATCH_COMPANION")
        let control = try origin("MUSTER_WATCH_CONTROL")
        let bot = try XCTUnwrap(ProcessInfo.processInfo.environment["MUSTER_WATCH_BOT"])
        XCTAssertNotEqual(companion.port, control.port)
        app.launch()
        let network = try pairIfNeeded(control: control, companion: companion)
        defer { network.invalidateAndCancel() }
        try tap("watch-chat-bot-" + bot)
        try tap("watch-open-call")
        try tap("watch-call-start")
        try tap("watch-call-connect")
        try tap("watch-call-plan-day")
        try tap("watch-calendar-connect")
        let calendarCode = app.descendants(matching: .any)["watch-calendar-code"].firstMatch
        guard calendarCode.waitForExistence(timeout: 15) else { throw NSError(domain: "OwnedWatchCalendarCodeMissing", code: 1) }
        _ = try reveal("watch-calendar-code")
        var approval = URLRequest(url: control.appendingPathComponent("calendar-approve"))
        approval.httpMethod = "POST"; approval.setValue("application/json", forHTTPHeaderField: "Content-Type")
        approval.httpBody = try JSONEncoder().encode(["code": calendarCode.label])
        let (_, approvalResponse) = try await network.data(for: approval)
        guard (approvalResponse as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "OwnedWatchCalendarApproval", code: 1) }
        try tap("watch-calendar-check")
        let selected = app.descendants(matching: .any)["watch-calendar-selected"].firstMatch
        guard selected.waitForExistence(timeout: 15) else { throw NSError(domain: "OwnedWatchCalendarNotConnected", code: 1) }
        _ = try reveal("watch-calendar-date")
        _ = try reveal("watch-calendar-time-zone")
        _ = try reveal("watch-calendar-work-start")
        _ = try reveal("watch-calendar-work-end")
        try enter("watch-calendar-priority-0", "Prepare owned report")
        _ = try reveal("watch-calendar-minutes-0")
        try tap("watch-calendar-prepare")
        let ready = app.descendants(matching: .any)["watch-calendar-draft-notice"].firstMatch
        guard ready.waitForExistence(timeout: 20) else { capture("calendar-draft-failure"); throw NSError(domain: "OwnedWatchCalendarDraftMissing", code: 1) }
        XCTAssertTrue(ready.label.contains("Draft ready"))
        let input = try reveal("watch-call-input")
        let draft = try XCTUnwrap(input.value as? String)
        XCTAssertTrue(draft.contains("Google Calendar read-only day read"))
        XCTAssertTrue(draft.contains("Prepare owned report"))
        XCTAssertTrue(draft.contains("owned-calendar"))
        XCTAssertTrue(draft.contains("Owned planning meeting"))
        // The system full-screen text editor must not end this foreground call.
        input.tap()
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        let connected = try reveal("watch-call-status")
        XCTAssertTrue(connected.label.contains("Connected"), "Keyboard dismissal ended the call")
        struct Status: Decodable { let userMessages: Int }
        // Baseline at assertion time, not zero: XCTest runs the chat test
        // first on a shared simulator, and its legitimate dispatch is not
        // this test's concern — only that planning/editing added none.
        let (beforeSend, _) = try await network.data(from: control.appendingPathComponent("status"))
        let baseline = try JSONDecoder().decode(Status.self, from: beforeSend).userMessages
        try tap("watch-call-send")
        let reply = app.descendants(matching: .any)["watch-call-reply"].firstMatch
        guard reply.waitForExistence(timeout: 30) else { throw NSError(domain: "OwnedWatchReplyMissing", code: 1) }
        _ = try reveal("watch-call-reply")
        let answer = NSPredicate(format: "label CONTAINS %@", "hello from fake acp")
        let answered = expectation(for: answer, evaluatedWith: reply)
        await fulfillment(of: [answered], timeout: 30)
        let picture = XCTAttachment(screenshot: app.screenshot()); picture.name = "watch-call-reply"; picture.lifetime = .keepAlways; add(picture)
        let (afterReply, _) = try await network.data(from: control.appendingPathComponent("status"))
        XCTAssertEqual(try JSONDecoder().decode(Status.self, from: afterReply).userMessages, baseline + 1)
        try tap("watch-call-end")
        let status = app.descendants(matching: .any)["watch-call-status"].firstMatch
        _ = try reveal("watch-call-status")
        let ended = expectation(for: NSPredicate(format: "label CONTAINS[c] %@", "ended"), evaluatedWith: status)
        await fulfillment(of: [ended], timeout: 15)
    }

    /// The chat face must answer a sent message with live feedback — the
    /// same contract the phone keeps — instead of silence until settle:
    /// a busy line before the first token, the streaming bubble while
    /// tokens flow, and the settled reply as a tappable tail bubble that
    /// opens the reader. The rig paces the fake engine (chunk at 1s,
    /// result at 3s) so the streaming window is deterministic.
    func testChatStreamsAndOpensReader() async throws {
        let companion = try origin("MUSTER_WATCH_COMPANION")
        let control = try origin("MUSTER_WATCH_CONTROL")
        let bot = try XCTUnwrap(ProcessInfo.processInfo.environment["MUSTER_WATCH_BOT"])
        app.launch()
        let network = try pairIfNeeded(control: control, companion: companion)
        defer { network.invalidateAndCancel() }
        try tap("watch-chat-bot-" + bot)
        // Dictate the message; the explicit Send is the app's job to prove.
        try enter("watch-composer-input", "stream check")
        try tap("watch-composer-send")

        // Phase 1 — before the first token (chunk lands at ~3s): the busy
        // line stands in. The settled reply is the failure signal here, not
        // a pass: if the poll sees it, the busy window was missed entirely.
        let thinking = app.descendants(matching: .any)["watch-thinking"].firstMatch
        guard thinking.waitForExistence(timeout: 10) else {
            let settledEarly = app.descendants(matching: .any)["watch-chat-reply"].firstMatch
            if settledEarly.exists {
                XCTFail("Busy line missed: the reply settled before phase 1 (fixture pacing too fast)")
            } else {
                capture("no-thinking-line")
                throw NSError(domain: "OwnedWatchNoThinkingLine", code: 1)
            }
            return
        }
        // Phase 2 — the streaming window (chunk at ~1s, result at ~3s): the
        // live bubble carries the tokens while the turn is still working.
        let live = app.descendants(matching: .any)["watch-streaming-bubble"].firstMatch
        guard live.waitForExistence(timeout: 10) else {
            capture("no-streaming-bubble")
            throw NSError(domain: "OwnedWatchStreamingBubbleMissing", code: 1)
        }
        XCTAssertTrue(live.label.contains("hello from fake acp"), "Live bubble must show the streamed tokens, got: \(live.label)")
        let picture = XCTAttachment(screenshot: app.screenshot()); picture.name = "watch-streaming-window"; picture.lifetime = .keepAlways; add(picture)

        // Phase 3 — settled: the live bubble is replaced by the newest tail
        // bubble carrying the finished reply, tappable into the reader. The
        // replacement is a one-frame SwiftUI swap, so poll for the live
        // entry to vanish rather than asserting against a stale snapshot:
        // XCTest can snapshot the tree mid-transition (settled tail present,
        // streaming node not yet torn down) and fail a plain .exists check.
        let tail = app.descendants(matching: .any)["watch-chat-reply"].firstMatch
        guard tail.waitForExistence(timeout: 15) else {
            capture("no-tail-bubble")
            throw NSError(domain: "OwnedWatchTailBubbleMissing", code: 1)
        }
        var liveGone = false
        for _ in 0..<15 {
            if !live.exists { liveGone = true; break }
            usleep(1_000_000)
        }
        XCTAssertTrue(liveGone, "Live bubble must disappear when the reply settles")
        try tap("watch-chat-reply")
        let reader = app.descendants(matching: .any)["watch-reader-body"].firstMatch
        guard reader.waitForExistence(timeout: 10) else {
            capture("reader-not-opened")
            throw NSError(domain: "OwnedWatchReaderNotOpened", code: 1)
        }
        XCTAssertTrue(reader.label.contains("hello from fake acp"))
    }

    /// Auto-pair: the phone shares its pairing over WatchConnectivity; the
    /// watch must reach the fleet without touching the pairing UI. The rig
    /// cannot create a physically paired iPhone+Watch simulator duo, so the
    /// test drives the same ingest the radio delivers into and then asserts
    /// the app never showed a code field — the fleet roster is up with zero
    /// pairing interaction. The credential is minted through the rig's own
    /// control plane exactly as the phone's pairing would have produced.
    func testHandoffFromPhonePairsWithoutPairingUI() async throws {
        let companion = try origin("MUSTER_WATCH_COMPANION")
        let control = try origin("MUSTER_WATCH_CONTROL")
        let bot = try XCTUnwrap(ProcessInfo.processInfo.environment["MUSTER_WATCH_BOT"])

        // Mint a pairing code the way the phone's successful pairing would
        // have (the control plane's POST /pairing, single-use).
        let network = URLSession(configuration: .ephemeral)
        defer { network.invalidateAndCancel() }
        var mint = URLRequest(url: control.appendingPathComponent("pairing"))
        mint.httpMethod = "POST"
        mint.timeoutInterval = 10
        let (mintData, mintResponse) = try await network.data(for: mint)
        XCTAssertEqual((mintResponse as? HTTPURLResponse)?.statusCode, 201)
        struct Mint: Decodable { let code: String }
        let minted = try JSONDecoder().decode(Mint.self, from: mintData)

        // The handoff payload the phone's WatchHandoffBridge would have
        // pushed: the connection plus the device token from redeeming that
        // code. Built BEFORE launch — launch arguments only apply at launch.
        var redeem = URLRequest(url: companion.appendingPathComponent("api/pair"))
        redeem.httpMethod = "POST"
        redeem.setValue("application/json", forHTTPHeaderField: "content-type")
        redeem.timeoutInterval = 10
        redeem.httpBody = try JSONEncoder().encode(["code": minted.code, "deviceName": "Watch via phone"])
        let (redeemData, redeemResponse) = try await network.data(for: redeem)
        XCTAssertEqual((redeemResponse as? HTTPURLResponse)?.statusCode, 201)
        struct Redeem: Decodable { let token: String }
        let redeemed = try JSONDecoder().decode(Redeem.self, from: redeemData)
        let handoff = CompanionHandoff(
            connection: Connection(name: "Owned Watch Rig", host: "127.0.0.1", port: companion.port!, scheme: .http),
            token: redeemed.token
        )
        let payload = try String(data: XCTUnwrap(CompanionHandoffCodec.encode(handoff)), encoding: .utf8)!

        // Launch once, with the handoff already waiting: the receiver
        // consumes it during attach, mirroring didReceiveApplicationContext.
        app.launchArguments = ["-watch-handoff-payload", payload]
        app.launch()

        // The fleet must appear with no pairing UI involvement whatsoever:
        // no code field may ever exist in this run.
        let codeField = app.descendants(matching: .any)["watch-pairing-code"].firstMatch
        let mascot = app.descendants(matching: .any)["watch-fleet-mascot"].firstMatch
        var sawFleet = false
        for _ in 0..<30 {
            if mascot.waitForExistence(timeout: 2) { sawFleet = true; break }
            XCTAssertFalse(codeField.exists, "Auto-pair must not route through the pairing UI")
        }
        guard sawFleet else {
            capture("handoff-never-paired")
            throw NSError(domain: "OwnedWatchHandoffNotPaired", code: 1)
        }
        let roster = app.descendants(matching: .any)["watch-chat-bot-" + bot].firstMatch
        guard roster.waitForExistence(timeout: 10) else {
            capture("handoff-no-roster")
            throw NSError(domain: "OwnedWatchHandoffNoRoster", code: 1)
        }
        let picture = XCTAttachment(screenshot: app.screenshot()); picture.name = "watch-handoff-paired"; picture.lifetime = .keepAlways; add(picture)
    }
}
