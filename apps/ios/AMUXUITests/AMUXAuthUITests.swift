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

    /// Full E2E test: signs in with the pre-created test account, then verifies the Sessions
    /// tab is reachable and the "New Session" button appears — which proves the app is
    /// authenticated, onboarded, and connected to the MQTT broker.
    @MainActor
    func testSignInAndMQTTConnects() throws {
        try XCTSkipIf(testEmail.isEmpty || testPassword.isEmpty,
                      "Set TEAMCLU_TEST_EMAIL and TEAMCLU_TEST_PASSWORD to run this test")

        // Handle the case where the app already has a valid session.
        let sessionsTab = app.tabBars.buttons["Sessions"]
        if sessionsTab.waitForExistence(timeout: 6) {
            sessionsTab.tap()
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
            app.tabBars.buttons["Sessions"].waitForExistence(timeout: 20),
            "Sessions tab should appear after successful sign-in"
        )
        app.tabBars.buttons["Sessions"].tap()

        assertMQTTConnected()
    }

    // MARK: - Daemon invite link

    /// Verifies the full daemon-invite flow: Actors tab → Invite sheet → Agent kind →
    /// backend creates the invite → deeplink is displayed and copyable.
    /// Requires auth credentials (same as testSignInAndMQTTConnects).
    @MainActor
    func testDaemonInviteLinkGenerated() throws {
        try XCTSkipIf(testEmail.isEmpty || testPassword.isEmpty,
                      "Set TEAMCLU_TEST_EMAIL and TEAMCLU_TEST_PASSWORD to run this test")

        // Reach the main UI (sign in if needed).
        if !app.tabBars.buttons["Actors"].waitForExistence(timeout: 6) {
            XCTAssertTrue(app.openLoginFromOnboarding())

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

            XCTAssertTrue(app.tabBars.buttons["Actors"].waitForExistence(timeout: 20),
                          "Actors tab should appear after sign-in")
        }

        // Navigate to Actors tab.
        app.tabBars.buttons["Actors"].tap()

        // Open the invite sheet. In iOS 26, ToolbarItem buttons use the SF Symbol name as
        // their XCUITest identifier regardless of .accessibilityIdentifier modifiers.
        let inviteButton = app.navigationBars["Actors"].buttons["person.badge.plus"]
        XCTAssertTrue(inviteButton.waitForExistence(timeout: 15),
                      "Invite button not found\n\(app.debugDescription)")
        inviteButton.tap()

        // Switch kind to "Agent". Picker(.segmented) doesn't propagate identifiers in iOS 26,
        // so find the segmented control by type and tap the "Agent" segment by label.
        let kindPicker = app.segmentedControls.firstMatch
        XCTAssertTrue(kindPicker.waitForExistence(timeout: 5),
                      "Kind picker should appear in invite sheet\n\(app.debugDescription)")
        kindPicker.buttons["Agent"].tap()

        // Enter a name for the daemon. TextField identifiers don't propagate in Form
        // sections on iOS 26, so find by type (there is only one text field in the sheet).
        let nameField = app.textFields.firstMatch
        XCTAssertTrue(nameField.waitForExistence(timeout: 3))
        nameField.tap()
        nameField.typeText("TestDaemon")

        // Tap Invite — toolbar button accessible via nav bar label.
        let inviteNavBar = app.navigationBars["Invite"]
        let submitButton = inviteNavBar.buttons["Invite"]
        XCTAssertTrue(submitButton.waitForExistence(timeout: 3))
        XCTAssertTrue(submitButton.isEnabled, "Invite button should be enabled after entering a name")
        submitButton.tap()

        // Wait for the deeplink to appear (backend round-trip).
        // staticText identifier doesn't propagate through Form/SwiftUI in iOS 26,
        // so match by label prefix instead.
        let deeplinkPredicate = NSPredicate(format: "label BEGINSWITH 'teamclu://'")
        let deeplinkText = app.staticTexts.matching(deeplinkPredicate).firstMatch
        XCTAssertTrue(deeplinkText.waitForExistence(timeout: 15),
                      "Deeplink should appear after invite is created\n\(app.debugDescription)")

        XCTAssertTrue(deeplinkText.label.hasPrefix("teamclu://"),
                      "Deeplink should use teamclu:// scheme, got: \(deeplinkText.label)")

        // Tap Copy link (no assertion — pasteboard is not readable in UI tests).
        let copyButton = app.buttons["Copy link"]
        XCTAssertTrue(copyButton.waitForExistence(timeout: 3))
        copyButton.tap()

        // Dismiss via Done button.
        let doneButton = inviteNavBar.buttons["Done"]
        XCTAssertTrue(doneButton.waitForExistence(timeout: 3))
        doneButton.tap()
    }

    // MARK: - Helpers

    /// Asserts the app is connected to MQTT by verifying the New Session button is present.
    /// The button only renders once the MQTT service is up and the daemon is reachable.
    private func assertMQTTConnected() {
        let newSessionButton = app.buttons["sessions.newSessionButton"]
        guard newSessionButton.waitForExistence(timeout: 15) else {
            let screenshot = XCUIScreen.main.screenshot()
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = "mqtt-connect-failure"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("New Session button did not appear — MQTT may not be connected.\n\(app.debugDescription)")
            return
        }
    }
}
