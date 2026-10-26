import XCTest

/// End-to-end tests for authentication and MQTT connection.
///
/// Requires environment variables set in the test scheme (or CI secrets):
///   TEAMCLU_TEST_EMAIL    — e.g. uitest@teamclu.tech
///   TEAMCLU_TEST_PASSWORD — password for the test account
///
/// The account must already exist in Supabase and belong to a team so the
/// app can reach the `.ready` route after sign-in.
final class AMUXAuthUITests: XCTestCase {

    private var app: XCUIApplication!

    // Credentials injected at test-scheme level; tests skip if absent.
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

    // MARK: - Password sign-in navigation

    /// Verifies the onboarding UI path: WelcomeView → "Get Started" → LoginView → password mode.
    /// Does not submit; validates that the password form is reachable and enables correctly.
    @MainActor
    func testPasswordSignInFormIsReachable() throws {
        // If already logged in the welcome screen won't appear — that's fine.
        guard app.openLoginFromOnboarding() else {
            // Already authenticated; registration screen is not shown.
            return
        }

        let emailField = app.textFields["login.emailField"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 5), "Email field should appear on LoginView")

        let methodPicker = app.segmentedControls["login.methodPicker"]
        XCTAssertTrue(methodPicker.waitForExistence(timeout: 3))
        methodPicker.buttons["Password"].tap()

        // Submit button should be disabled until both fields are filled
        let submitButton = app.buttons["login.submitButton"]
        XCTAssertTrue(submitButton.waitForExistence(timeout: 3))
        XCTAssertFalse(submitButton.isEnabled, "Submit should be disabled with empty fields")

        // Fill in a unique (but fictional) test email and a password
        let uniqueEmail = "uitest+\(UUID().uuidString.prefix(8).lowercased())@example.invalid"
        emailField.tap()
        emailField.typeText(uniqueEmail)

        let passwordField = app.secureTextFields["login.passwordField"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 3))
        passwordField.tap()
        passwordField.typeText("Password1!")

        XCTAssertTrue(submitButton.isEnabled, "Submit should be enabled once both fields are filled")
    }

    // MARK: - Onboarding: start a new team

    /// Choice → "Start a new team" → desktop-download guide → sign-in.
    @MainActor
    func testStartNewTeamPathReachesDesktopGuideThenLogin() throws {
        let getStarted = app.buttons["welcome.getStartedButton"]
        let create = app.buttons["onboarding.createButton"]
        if getStarted.waitForExistence(timeout: 6) {
            getStarted.tap()
        }
        guard create.waitForExistence(timeout: 3) else {
            // Already authenticated; onboarding is not shown.
            return
        }
        create.tap()

        XCTAssertTrue(app.buttons["desktopGuide.shareButton"].waitForExistence(timeout: 5),
                      "Desktop guide should offer to share the download link")
        XCTAssertTrue(app.buttons["desktopGuide.copyButton"].exists)

        app.buttons["desktopGuide.continueButton"].tap()
        XCTAssertTrue(app.textFields["login.emailField"].waitForExistence(timeout: 5),
                      "Continuing from the desktop guide should reach LoginView")
    }

    // MARK: - Sign-in + MQTT connection

    /// Full E2E test: signs in with the pre-created test account, then verifies the session
    /// list and its bottom bar appear — which proves the app is authenticated, onboarded,
    /// and connected to the MQTT broker.
    @MainActor
    func testSignInAndMQTTConnects() throws {
        try XCTSkipIf(testEmail.isEmpty || testPassword.isEmpty,
                      "Set TEAMCLU_TEST_EMAIL and TEAMCLU_TEST_PASSWORD to run this test")

        // Handle the case where the app already has a valid session.
        if app.waitForHome(timeout: 6) {
            assertMQTTConnected()
            return
        }

        // Not authenticated — go through the login flow.
        XCTAssertTrue(app.openLoginFromOnboarding(), "Onboarding should appear when not authenticated")

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

        let submitButton = app.buttons["login.submitButton"]
        XCTAssertTrue(submitButton.isEnabled)
        submitButton.tap()

        // Wait for the app to reach the main UI (auth + bootstrap + MQTT connect).
        XCTAssertTrue(
            app.waitForHome(timeout: 20),
            "Session list should appear after successful sign-in"
        )

        assertMQTTConnected()
    }

    // MARK: - Daemon invite link

    /// Menu → Actors → Invite → name an agent → the backend mints an invite and
    /// the sheet shows its deeplink. The sheet only invites agents now.
    @MainActor
    func testDaemonInviteLinkGenerated() throws {
        XCTAssertTrue(app.signInIfNeeded(), "Not signed in and no E2E account configured")

        let inviteButton = app.buttons["members.inviteButton"]
        XCTAssertTrue(app.openHomeMenuItem("sessions.menu.members", timeout: 20)
                      && inviteButton.waitForExistence(timeout: 8),
                      "Invite button not found\n\(app.debugDescription)")
        inviteButton.tap()

        let nameField = app.textFields["invite.nameField"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap()
        nameField.typeText("TestDaemon")

        let submit = app.buttons["invite.submitButton"]
        XCTAssertTrue(submit.waitForExistence(timeout: 3))
        XCTAssertTrue(submit.isEnabled, "Invite should be enabled once named")
        submit.tap()

        // Backend round-trip: Invite turns into Done once the invite exists.
        let done = app.buttons["invite.doneButton"]
        XCTAssertTrue(done.waitForExistence(timeout: 15),
                      "Invite was not created\n\(app.debugDescription)")

        // The sheet opens at half height and its Form is lazy: the share
        // section sits below the fold and is not in the tree until scrolled
        // to. The scheme is whatever the deployment issues, so check the
        // invite's shape rather than a fixed scheme.
        let deeplink = app.staticTexts["invite.deeplinkText"]
        for _ in 0..<4 where !deeplink.exists {
            app.swipeUp()
        }
        XCTAssertTrue(deeplink.waitForExistence(timeout: 5),
                      "Deeplink not shown for the new invite\n\(app.debugDescription)")
        XCTAssertTrue(deeplink.label.contains("invite?token="),
                      "Unexpected invite link: \(deeplink.label)")

        let copy = app.buttons["invite.copyLinkButton"]
        XCTAssertTrue(copy.waitForExistence(timeout: 3))
        copy.tap()

        XCTAssertTrue(done.waitForExistence(timeout: 3))
        done.tap()
    }

    // MARK: - Helpers

    /// Asserts the app reached the session list by verifying its bottom bar is present.
    private func assertMQTTConnected() {
        let newSessionButton = app.homeComposerField
        guard newSessionButton.waitForExistence(timeout: 15) else {
            let screenshot = XCUIScreen.main.screenshot()
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = "mqtt-connect-failure"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("Session list bottom bar did not appear — MQTT may not be connected.\n\(app.debugDescription)")
            return
        }
    }
}
