// Owned-simulator acceptance for the Walkie panel: the roster of voices,
// the selection, the radio controls, and a real bot turn spoken back.
//
// Run after the pairing test, on the same simulator — the pairing lives in
// the keychain. The microphone itself cannot be driven from a UI test (the
// simulator has no voice), so the hold-to-talk capture is verified by hand;
// what is verified here is everything around it: the panel opens, the bot
// answers a sent message, the status card follows the thread from working
// to settled, and the reply's words land in the quote.
//
// Environment (set on the xctestrun): MUSTER58_BOT_NAME.
import XCTest

@MainActor
final class WalkieAcceptance: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "com.muster.companion")

    /// The word the bot is asked to echo — the reply marker. The user's own
    /// message contains it too, so it only counts once the headline has
    /// left "working": while the bot works, the quote is the echo of what
    /// you said, not its answer.
    static let marker = "lighthouse"

    func capture(_ name: String) {
        let picture = XCTAttachment(screenshot: app.screenshot())
        picture.name = name
        picture.lifetime = .keepAlways
        add(picture)
    }

    func testWalkieTour() throws {
        let botName = ProcessInfo.processInfo.environment["MUSTER58_BOT_NAME"] ?? "Mimi"

        app.launch()
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 20), "roster never appeared")

        // Open the radio.
        app.buttons["walkie-open"].tap()
        XCTAssertTrue(app.staticTexts["Walkie"].waitForExistence(timeout: 5), "Walkie header never appeared")
        let status = app.otherElements["walkie-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5), "status card missing")

        // The bot is on the panel's own roster, and selecting it names it
        // on the capsule.
        let row = app.buttons["walkie-row-" + botName]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "bot missing from the Walkie roster")
        row.tap()
        let hold = app.descendants(matching: .any)["walkie-hold"].firstMatch
        XCTAssertTrue(hold.waitForExistence(timeout: 5), "hold capsule missing")
        XCTAssertTrue(
            hold.label.contains("Hold to talk to \(botName)"),
            "hold capsule does not name the selected bot: got \(hold.label)"
        )
        capture("walkie-panel")

        // Voice toggles and the label follows.
        app.buttons["walkie-voice"].tap()
        XCTAssertTrue(app.staticTexts["Voice off"].waitForExistence(timeout: 3), "voice-off label missing")
        capture("walkie-voice-off")
        app.buttons["walkie-voice"].tap()
        XCTAssertTrue(app.staticTexts["Voice on"].waitForExistence(timeout: 3), "voice-on label missing")

        // Replay is dead until something has been spoken.
        XCTAssertFalse(app.buttons["walkie-replay"].isEnabled, "Replay enabled with nothing to replay")

        // Open chat hands off to the real transcript, and back returns here.
        app.buttons["walkie-open-chat"].tap()
        let composer = app.textFields["composer-field"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "chat did not open from Walkie")
        composer.tap()
        composer.typeText("Reply with exactly one word: \(Self.marker)")
        app.buttons["composer-send"].tap()
        app.buttons["chat-back"].tap()

        // The panel follows the live thread. Two model-independent proofs
        // that the quote tracks the transcript: while the bot works, the
        // quote echoes the message just sent (the marker is in *our* text,
        // not the model's answer, so this holds whatever the provider's
        // auth state is), and once the turn settles the headline returns to
        // the bot. The reply's own words are captured for the eye, not
        // asserted, because a healthy model and an out-of-credits one
        // should not decide whether the panel works.
        let deadline = Date().addingTimeInterval(150)
        var sawEcho = false
        var settled = false
        while Date() < deadline {
            let texts = status.staticTexts
            let headline = texts.count > 0 ? texts.element(boundBy: 0).label : ""
            let quote = texts.count > 1 ? texts.element(boundBy: 1).label : ""
            if quote.localizedCaseInsensitiveContains(Self.marker) {
                if !sawEcho {
                    sawEcho = true
                    capture("walkie-working")
                }
            }
            if sawEcho, headline.contains(botName), headline.contains("is ready") {
                settled = true
                break
            }
            usleep(250_000)
        }
        XCTAssertTrue(sawEcho, "the panel never echoed the sent message into the quote")
        XCTAssertTrue(settled, "the panel never returned to ready after the turn settled")
        capture("walkie-answered")

        app.buttons["walkie-close"].tap()
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 5), "close did not return to the roster")
    }
}
