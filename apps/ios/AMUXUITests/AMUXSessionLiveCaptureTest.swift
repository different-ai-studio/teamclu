import XCTest

/// Drives the simulator app through sign-in → Sessions tab → tap-first-
/// available-session so the MQTTTraceRecorder captures session/{id}/live
/// retained + live traffic. Used out-of-band by a developer with the
/// TeamcluRecordMQTT flag set in the simulator's UserDefaults; the captured
/// jsonl trace becomes a fixture in AMUXCore/Tests/Resources.
///
/// Not part of the CI test action. Requires:
///   - TEAMCLU_TEST_EMAIL / TEAMCLU_TEST_PASSWORD env vars
///   - The signed-in account to already have at least one session row
///   - A daemon reachable from the simulator
///
/// Skip-friendly: if the env vars are missing or no session row appears,
/// the test exits without failure.
final class AMUXSessionLiveCaptureTest: XCTestCase {

    private var app: XCUIApplication!

    private var testEmail: String {
        ProcessInfo.processInfo.environment["TEAMCLU_TEST_EMAIL"] ??
            ProcessInfo.processInfo.environment["AMUX_TEST_EMAIL"] ?? ""
    }

    private var testPassword: String {
        ProcessInfo.processInfo.environment["TEAMCLU_TEST_PASSWORD"] ??
            ProcessInfo.processInfo.environment["AMUX_TEST_PASSWORD"] ?? ""
    }

    override func setUpWithError() throws {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
    }

    @MainActor
    func testCaptureFirstSessionLive() throws {
        try XCTSkipIf(testEmail.isEmpty || testPassword.isEmpty,
                      "Set TEAMCLU_TEST_EMAIL and TEAMCLU_TEST_PASSWORD")
        signInIfNeeded()

        let sessionsTab = app.tabBars.buttons["Sessions"]
        XCTAssertTrue(sessionsTab.waitForExistence(timeout: 20))
        sessionsTab.tap()

        // First actual session row. boundBy(0) is the "Today" section
        // header on iOS 26's UICollectionView-backed List; (1) is the
        // first selectable session. Mirrors AMUXSessionLiveDiagTest.
        let cells = app.collectionViews.cells
        guard cells.element(boundBy: 0).waitForExistence(timeout: 12) else {
            print("[capture] sessions list empty; only cold-start retained traffic captured")
            return
        }
        let sessionCell = cells.element(boundBy: 1)
        guard sessionCell.exists else {
            print("[capture] no session row beyond the section header; cold-start only")
            return
        }
        sessionCell.tap()

        // Active session/live traffic only flows when something
        // changes. Send a fresh prompt so the daemon streams a reply
        // back over session/{id}/live and the recorder captures the
        // full streaming-output dance.
        let needle = "trace-capture-\(Int(Date().timeIntervalSince1970))"
        let composer = app.textFields["composer.textField"]
        if composer.waitForExistence(timeout: 6) {
            composer.tap()
            composer.typeText("Reply with exactly: \(needle)")
            let send = app.buttons["composer.sendButton"]
            if send.waitForExistence(timeout: 3), send.isEnabled {
                send.tap()
            }
        }

        // Stay on the detail view long enough to receive the streaming
        // reply. Daemon ACP bring-up takes ~6s when the runtime is
        // cold; the agent's reply itself streams for a few more
        // seconds. 45s leaves headroom for the longer side of normal.
        sleep(45)

        // Navigate back so the file handle synchronizes before tearDown.
        if app.navigationBars.buttons.firstMatch.exists {
            app.navigationBars.buttons.firstMatch.tap()
        }
        sleep(2)
    }

    // MARK: - Helpers (copy of AMUXAuthUITests pattern)

    private func signInIfNeeded() {
        let sessionsTab = app.tabBars.buttons["Sessions"]
        if sessionsTab.waitForExistence(timeout: 6) { return }

        XCTAssertTrue(app.openLoginFromOnboarding(timeout: 8))

        let methodPicker = app.segmentedControls["login.methodPicker"]
        XCTAssertTrue(methodPicker.waitForExistence(timeout: 3))
        methodPicker.buttons["Password"].tap()
        let emailField = app.textFields["login.emailField"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 5))
        emailField.tap()
        emailField.typeText(testEmail)

        let passwordField = app.secureTextFields["login.passwordField"]
        passwordField.tap()
        passwordField.typeText(testPassword)

        app.buttons["login.submitButton"].tap()
        XCTAssertTrue(sessionsTab.waitForExistence(timeout: 20),
                      "Sign-in did not reach Sessions tab")
    }
}
