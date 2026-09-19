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
        let isScrollScreen = isCall || identifier == "watch-open-call"
        let container = isScrollScreen ? app.scrollViews.firstMatch : app.collectionViews.firstMatch
        let top = isCall ? 52.0 : 65.0
        let dragX = isCall ? 0.98 : 0.5
        guard container.waitForExistence(timeout: 10) else { throw NSError(domain: "OwnedWatchMissingScrollContainer", code: 1) }
        for index in 0..<6 {
            if app.buttons["Done"].firstMatch.exists {
                capture("unexpected-keyboard-" + identifier)
                throw NSError(domain: "OwnedWatchUnexpectedKeyboard", code: 1)
            }
            print("Owned reveal \(identifier) step \(index): \(element.exists ? String(describing: element.frame) : "absent")")
            if element.exists {
                let frame = element.frame
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

    func testExplicitForegroundCall() async throws {
        let companion = try origin("MUSTER_WATCH_COMPANION")
        let control = try origin("MUSTER_WATCH_CONTROL")
        let bot = try XCTUnwrap(ProcessInfo.processInfo.environment["MUSTER_WATCH_BOT"])
        XCTAssertNotEqual(companion.port, control.port)
        app.launch()
        try enter("pairing-address-input", companion.absoluteString)
        try tap("watch-use-address")
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        let network = URLSession(configuration: config, delegate: OwnedWatchRedirectPolicy(), delegateQueue: nil)
        defer { network.invalidateAndCancel() }
        var request = URLRequest(url: control.appendingPathComponent("pairing")); request.httpMethod = "POST"
        let (data, response) = try await network.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        struct Pairing: Decodable { let code: String }
        let code = try JSONDecoder().decode(Pairing.self, from: data).code
        try enter("watch-pairing-code", code)
        try tap("watch-pairing-submit")
        guard app.descendants(matching: .any)["watch-fleet-mascot"].firstMatch.waitForExistence(timeout: 25) else {
            capture("pairing-did-not-reach-fleet")
            throw NSError(domain: "OwnedWatchPairingDidNotReachFleet", code: 1)
        }
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
        let (beforeSend, _) = try await network.data(from: control.appendingPathComponent("status"))
        XCTAssertEqual(try JSONDecoder().decode(Status.self, from: beforeSend).userMessages, 0, "Planning or editing dispatched automatically")
        try tap("watch-call-send")
        let reply = app.descendants(matching: .any)["watch-call-reply"].firstMatch
        guard reply.waitForExistence(timeout: 30) else { throw NSError(domain: "OwnedWatchReplyMissing", code: 1) }
        _ = try reveal("watch-call-reply")
        let answer = NSPredicate(format: "label CONTAINS %@", "hello from fake acp")
        let answered = expectation(for: answer, evaluatedWith: reply)
        await fulfillment(of: [answered], timeout: 30)
        let picture = XCTAttachment(screenshot: app.screenshot()); picture.name = "watch-call-reply"; picture.lifetime = .keepAlways; add(picture)
        let (afterReply, _) = try await network.data(from: control.appendingPathComponent("status"))
        XCTAssertEqual(try JSONDecoder().decode(Status.self, from: afterReply).userMessages, 1)
        try tap("watch-call-end")
        let status = app.descendants(matching: .any)["watch-call-status"].firstMatch
        _ = try reveal("watch-call-status")
        let ended = expectation(for: NSPredicate(format: "label CONTAINS[c] %@", "ended"), evaluatedWith: status)
        await fulfillment(of: [ended], timeout: 15)
    }
}
