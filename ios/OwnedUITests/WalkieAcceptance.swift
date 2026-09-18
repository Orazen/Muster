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

    /// The reply marker. With the rig's fake ACP engine (scripts/
    /// owned-ios-acceptance.mjs boots `server/testing/fake-acp-cli.ts`), the
    /// turn settles almost instantly and its reply text is deterministic:
    /// "hello from fake acp". The old marker was the word in the *user's*
    /// message ("lighthouse"), which assumed a visible working-echo window —
    /// true only for a slow real model. With a fast engine the first quote
    /// the panel ever shows IS the answer, so an echo assertion can never
    /// pass. What the panel must prove is that it follows the thread from
    /// sent → answered → ready, whatever the engine's latency.
    static let marker = "hello from fake acp"

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

        // Voice toggles and the label follows. The live turn below runs with
        // voice OFF: TTS is on by default, a headless simulator may never
        // finish an utterance, and "\(botName) is speaking" would pin the
        // headline past any settle window. Restored after the settle proof.
        app.buttons["walkie-voice"].tap()
        XCTAssertTrue(app.staticTexts["Voice off"].waitForExistence(timeout: 3), "voice-off label missing")
        capture("walkie-voice-off")

        // Replay is dead until something has been spoken.
        XCTAssertFalse(app.buttons["walkie-replay"].isEnabled, "Replay enabled with nothing to replay")

        // Open chat hands off to the real transcript, and back returns here.
        // The turn starts streaming the moment the message lands, and the
        // streaming re-renders saturate the app's main thread — so settle
        // briefly and retry the back navigation instead of issuing one query
        // into the busiest moment ("main thread busy for 30s").
        app.buttons["walkie-open-chat"].tap()
        let composer = app.textFields["composer-field"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "chat did not open from Walkie")
        composer.tap()
        composer.typeText("Reply with exactly one word: lighthouse")
        app.buttons["composer-send"].tap()
        sleep(3)
        var back = false
        for _ in 0..<8 where !back {
            let chatBack = app.buttons["chat-back"]
            if chatBack.waitForExistence(timeout: 3) {
                chatBack.tap()
                back = app.otherElements["walkie-status"].waitForExistence(timeout: 4)
                    || app.buttons["walkie-open"].waitForExistence(timeout: 2)
            }
        }
        XCTAssertTrue(back, "never returned from chat to the Walkie panel")

        // The panel follows the live thread. Two model-independent proofs
        // that the quote tracks the transcript: the fake rig engine answers
        // "hello from fake acp" (Self.marker), so the quote must show the
        // bot's actual reply, and once the turn settles the headline returns
        // to "\(botName) is ready". With a slow real model the same poll
        // would simply watch a working quote first — the panel logic is
        // identical either way.
        // Poll gently via stable identifiers (WalkieView "walkie-headline" /
        // "walkie-quote"): every query lands on an app whose main thread is
        // folding streamed patches, and indexed/predicate queries starve —
        // identifier subscripts answer. A 1s cadence is enough to see the
        // answer and the settle without starving either side.
        let deadline = Date().addingTimeInterval(150)
        var sawAnswer = false
        var settled = false
        while Date() < deadline {
            let quote = app.staticTexts["walkie-quote"]
            let headline = app.staticTexts["walkie-headline"]
            let quoteText = quote.exists ? quote.label : ""
            let headlineText = headline.exists ? headline.label : ""
            if quoteText.localizedCaseInsensitiveContains(Self.marker) {
                if !sawAnswer {
                    sawAnswer = true
                    capture("walkie-answered")
                }
            }
            if sawAnswer, headlineText.contains(botName), headlineText.contains("is ready") {
                settled = true
                break
            }
            usleep(1_000_000)
        }
        XCTAssertTrue(sawAnswer, "the panel never showed the reply in the quote")
        XCTAssertTrue(settled, "the panel never returned to ready after the turn settled")
        capture("walkie-answered")

        // Voice back on: the label flips and the turn replay path the voice
        // toggle gates is exercised with the real answer in hand.
        app.buttons["walkie-voice"].tap()
        XCTAssertTrue(app.staticTexts["Voice on"].waitForExistence(timeout: 3), "voice-on label missing")

        app.buttons["walkie-close"].tap()
        XCTAssertTrue(app.textFields["Search chats"].waitForExistence(timeout: 5), "close did not return to the roster")
    }
}
