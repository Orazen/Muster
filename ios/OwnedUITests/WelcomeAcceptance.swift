// Owned-simulator acceptance for the GAIA-style welcome onboarding.
// Three tests, independent of each other and of the pairing rig:
//   1. The hero renders and the primary actions exist (cold launch).
//   2. "Pair with your computer" completes onboarding → PairingView.
//   3. Google sign-in opens the cloud's web sheet and CANCELS cleanly
//      (no error text, no partial state) — the honest network-free proof.
// No companion server is needed: the welcome is app-local. Screenshots ride
// as attachments; the skip flag is reset in setUp so every test starts cold.
import XCTest

@MainActor
final class WelcomeAcceptance: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "com.muster.companion")
    let defaults = "onboardingWelcomeSeen.v1"

    override func setUp() {
        continueAfterFailure = false
        // Cold start every time: no seen-flag, no pairing (fresh simulators
        // used by the owned rig have neither).
        app.launchArguments = ["-com.muster.companion.reset-welcome", "1"]
        app.launch()
    }

    func capture(_ name: String) {
        let picture = XCTAttachment(screenshot: app.screenshot())
        picture.name = name
        picture.lifetime = .keepAlways
        add(picture)
    }

    private func waitWelcome() {
        XCTAssertTrue(app.descendants(matching: .any)["welcome-title"].firstMatch.waitForExistence(timeout: 15),
                      "welcome never appeared")
    }

    func testWelcomeRenders() {
        waitWelcome()
        capture("welcome-hero")
        XCTAssertTrue(app.buttons["welcome-google"].exists, "Google button missing")
        XCTAssertTrue(app.buttons["welcome-pair"].exists, "Pair button missing")
        XCTAssertTrue(app.buttons["welcome-skip"].exists, "Skip missing")
        XCTAssertTrue(app.buttons["welcome-google"].isHittable, "Google button not visible")
        XCTAssertTrue(app.buttons["welcome-pair"].isHittable, "Pair button not visible")
    }

    func testPairButtonCompletesOnboarding() {
        waitWelcome()
        app.buttons["welcome-pair"].tap()
        // RootView routes on the flag flip: the pairing screen replaces the
        // welcome without a relaunch.
        XCTAssertTrue(app.descendants(matching: .any)["pairing-scan"].firstMatch.waitForExistence(timeout: 15),
                      "pairing screen never appeared after Pair tap")
        capture("welcome-to-pairing")
        // The flag persists: relaunch WITHOUT the reset argument — the
        // reset arg exists to make tests cold, and would defeat exactly
        // the persistence this relaunch proves.
        app.terminate()
        app.launchArguments = []
        app.launch()
        XCTAssertFalse(app.descendants(matching: .any)["welcome-title"].firstMatch.exists,
                       "welcome came back after onboarding was completed")
    }

    func testGoogleSignInCancelsCleanly() throws {
        // The cloud must actually be configured, or the sheet never opens
        // and this test proves nothing.
        guard ProcessInfo.processInfo.environment["MUSTER_WELCOME_CLOUD_LIVE"] == "1" else {
            throw XCTSkip("cloud live-check disabled (MUSTER_WELCOME_CLOUD_LIVE unset)")
        }
        waitWelcome()
        app.buttons["welcome-google"].tap()
        // The ASWebAuthenticationSession sheet appears in the app's own
        // process on modern iOS; give it a moment, then cancel.
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 20), "Google sign-in sheet never appeared")
        capture("welcome-signin-sheet")
        cancel.tap()
        // Canceled login is not an error: the hero stays, no error text.
        XCTAssertTrue(app.descendants(matching: .any)["welcome-title"].firstMatch.waitForExistence(timeout: 10),
                      "welcome did not return after cancel")
        XCTAssertFalse(app.descendants(matching: .any)["welcome-error"].firstMatch.exists,
                       "a canceled sign-in must not show an error")
        capture("welcome-after-cancel")
    }
}
