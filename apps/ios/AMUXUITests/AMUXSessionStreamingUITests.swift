import XCTest

/// End-to-end test that drives the iOS UI through:
///   sign in → New Session → submit prompt → wait for streamed assistant output.
///
/// Verifies the full data path: Supabase JWT auth, MQTT CONNACK, teamclu
/// `runtime_start` RPC to the daemon, ACP event stream flowing back through
/// `device/{daemon}/runtime/{id}/events`, and SwiftUI rendering of the
/// assistant message bubble.
///
/// ## Required environment
///
///   - `TEAMCLU_TEST_EMAIL`, `TEAMCLU_TEST_PASSWORD` in the test scheme. The
///     account must be a **member** of a team with **exactly one** agent
///     it can access (entry in `agent_member_access`).
///   - A daemon running with that agent's `actor_id` and reachable from
///     the simulator over MQTT/EMQX.
///
/// ## Known iOS gaps this test exercises (and currently fails on)
///
/// 1. `NewSessionSheet` does not auto-select `primaryAgentID` from
///    `connectedAgentsStore` on `.appear`. `primaryAgentID` is only set
///    when the user opens the Collaborators picker. Without it, the
///    workspace + agent rows never render and `sendAndCreate()`'s
///    `effectiveDeviceID` falls back to `pairing.deviceId` — which after
///    Phase 4 (no invite token) is empty, so the RPC is rejected with
///    "Daemon device ID is not configured" or routed to `device//rpc/res`.
///
/// 2. `pairing.deviceId` is overloaded as both the iOS-install UUID
///    (used as `sender_device_id` for RPC reply routing) and the
///    user-configurable Daemon ID in Settings. With static MQTT creds
///    removed, neither value is auto-populated on first launch, so
///    every teamclu RPC silently round-trips to the wrong topic.
///
/// Both are tracked as Phase 4 follow-ups; once fixed, this test should
/// pass without skips. The streaming pipeline below the iOS layer is
/// already verified end-to-end via the Python wire test (see
/// `/tmp/streaming_e2e.py` during the Phase 4 cutover session).
final class AMUXSessionStreamingUITests: XCTestCase {

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
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    @MainActor
    func testNewSessionStreamsAssistantOutput() throws {
        try XCTSkipIf(testEmail.isEmpty || testPassword.isEmpty,
                      "Set TEAMCLU_TEST_EMAIL and TEAMCLU_TEST_PASSWORD to run this test")

        signInIfNeeded()

        let sessionsTab = app.tabBars.buttons["Sessions"]
        XCTAssertTrue(sessionsTab.waitForExistence(timeout: 20),
                      "Sessions tab should appear after sign-in")
        sessionsTab.tap()

        let newSessionButton = app.buttons["sessions.newSessionButton"]
        XCTAssertTrue(newSessionButton.waitForExistence(timeout: 15),
                      "New Session button should be reachable on the Sessions tab")
        newSessionButton.tap()

        let messageField = app.textFields["newSession.messageField"]
        XCTAssertTrue(messageField.waitForExistence(timeout: 10),
                      "New Session message field should appear")

        // The Agent picker (segmented control with "Claude"/"OpenCode"/"Codex")
        // only renders once `primaryAgentID` is set. Today this requires a
        // user to drive the Collaborators picker — see gap #1 in the file
        // header.
        let agentSegment = app.segmentedControls.buttons["Claude"]
        XCTAssertTrue(agentSegment.waitForExistence(timeout: 30),
                      "Agent picker did not render — `primaryAgentID` was never set. See gap #1 in the file header.\n\(app.debugDescription)")

        messageField.tap()
        messageField.typeText("Reply with exactly: hi from amux ui test")

        let sendButton = app.buttons["newSession.sendButton"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
        XCTAssertTrue(sendButton.isEnabled, "Send button should be enabled once the prompt and agent are ready")
        sendButton.tap()

        // After Send the sheet dismisses and the app navigates to the agent
        // detail view. Wait for the assistant's streamed output. CONTAINS
        // matches the message regardless of which SwiftUI view it lands in.
        let needle = "hi from amux ui test"
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", needle)
        let streamedText = app.staticTexts.matching(predicate).firstMatch

        // Generous timeout: model latency + ACP startup + MQTT round-trip.
        guard streamedText.waitForExistence(timeout: 90) else {
            attachScreenshot(named: "streaming-failure")
            XCTFail("Did not see assistant output containing \(needle.debugDescription) within 90s.\n\(app.debugDescription)")
            return
        }
    }

    // MARK: - Helpers

    /// Drives the WelcomeView → LoginView flow if the app is not already
    /// signed in. No-op once a session exists.
    private func signInIfNeeded() {
        if app.tabBars.buttons["Sessions"].waitForExistence(timeout: 6) {
            return
        }
        XCTAssertTrue(app.openLoginFromOnboarding(),
                      "Onboarding should appear when not authenticated")

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
    }

    private func attachScreenshot(named name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
