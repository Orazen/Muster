// Owned-simulator acceptance for the native flower mascot and the chat
// header's task label. Two tests, meant to run as two separate invocations:
// the first pairs the app against a scratch rig (deep link + one confirm
// tap), the second tours what this slice changed and captures screenshots
// as attachments. Environment (set on the xctestrun): MUSTER58_PAIR_URL,
// MUSTER58_BOT_NAME, MUSTER58_TASK_TITLE.
import XCTest

@MainActor
final class IdentityAcceptance: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "com.muster.companion")

    func capture(_ name: String) {
        let picture = XCTAttachment(screenshot: app.screenshot())
        picture.name = name
        picture.lifetime = .keepAlways
        add(picture)
    }

    func testPairAcceptsInvite() throws {
        let env = ProcessInfo.processInfo.environment
        let url = try XCTUnwrap(URL(string: try XCTUnwrap(env["MUSTER58_PAIR_URL"])), "pair URL missing")
        app.launch()
        XCUIDevice.shared.system.open(url)
        // iOS may ask before handing a custom-scheme URL to the app, and on a
        // cold simulator the prompt can land well after the open call. Keep
        // watching for it until the confirm screen shows — whichever comes
        // first. A missed prompt otherwise dead-ends the test with
        // "pairing confirm never appeared".
        let prompt = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        let open = prompt.buttons["Open"]
        let confirm = app.buttons["pairing-confirm"]
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if open.waitForExistence(timeout: 1) { open.tap(); continue }
            if confirm.exists { break }
        }
        XCTAssertTrue(confirm.waitForExistence(timeout: 20), "pairing confirm never appeared")
        confirm.tap()
        // whatever happened, the next screen is the evidence
        sleep(2)
        capture("post-confirm")
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 20), "roster never appeared after pairing")
        capture("paired-roster")
    }

    func testIdentityTour() throws {
        let env = ProcessInfo.processInfo.environment
        let botName = env["MUSTER58_BOT_NAME"] ?? "Mimi"
        let taskTitle = env["MUSTER58_TASK_TITLE"] ?? ""

        app.launch()
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 20), "roster never appeared")
        capture("tour-roster")

        let row = app.staticTexts[botName]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "bot row missing from roster")
        capture("tour-roster")

        // The header capsule is one accessibility element (children ignored,
        // so VoiceOver reads who + task as one). SwiftUI exposes the Button
        // itself with the flattened child label ("Name, task title") under a
        // wrapper that carries the fuller spoken summary — match THAT shape:
        // it begins with the bot's name, which also rules out the computer
        // toolbar button ("Watch <name>'s computer").
        let header = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", botName, taskTitle)
        ).firstMatch
        // a static-text tap inside a NavigationLink is occasionally eaten —
        // retry until the header proves the chat is open
        var navigated = false
        for _ in 0..<3 where !navigated {
            row.tap()
            navigated = header.waitForExistence(timeout: 6)
        }
        XCTAssertTrue(navigated, "chat never opened")
        if !taskTitle.isEmpty {
            XCTAssertTrue(header.label.contains(taskTitle), "header label does not carry the task title: \(header.label)")
        }
        capture("tour-chat-header")

        // full-context reveal: the truncated label opens the full task list
        header.tap()
        XCTAssertTrue(app.navigationBars["\(botName)’s tasks"].waitForExistence(timeout: 10), "task sheet never opened")
        capture("tour-task-sheet")

        // Dynamic Type: the same roster under accessibility-sized text.
        app.terminate()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
        app.launch()
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 20), "roster never reappeared")
        capture("tour-large-type-roster")
    }
}
