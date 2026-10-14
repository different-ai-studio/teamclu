import XCTest

extension XCUIApplication {
    /// Signed out → LoginView: past the intro cards (first install only) and
    /// the join/create choice. False when neither screen shows up — usually
    /// because the app is already signed in.
    @discardableResult
    func openLoginFromOnboarding(timeout: TimeInterval = 6) -> Bool {
        let getStarted = buttons["welcome.getStartedButton"]
        let join = buttons["onboarding.joinButton"]
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !getStarted.exists, !join.exists {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        if getStarted.exists {
            getStarted.tap()
        }
        guard join.waitForExistence(timeout: 3) else { return false }
        join.tap()
        return true
    }
}

/// The E2E account from the scheme (`TEAMCLU_TEST_EMAIL` /
/// `TEAMCLU_TEST_PASSWORD`, or the older `AMUX_TEST_*` spellings). Empty when
/// unset.
enum E2EAccount {
    static var email: String {
        ProcessInfo.processInfo.environment["TEAMCLU_TEST_EMAIL"]
            ?? ProcessInfo.processInfo.environment["AMUX_TEST_EMAIL"] ?? ""
    }
    static var password: String {
        ProcessInfo.processInfo.environment["TEAMCLU_TEST_PASSWORD"]
            ?? ProcessInfo.processInfo.environment["AMUX_TEST_PASSWORD"] ?? ""
    }
    static var isConfigured: Bool { !email.isEmpty && !password.isEmpty }
}

extension XCUIApplication {
    /// Signs in with the E2E account unless the app already shows the main
    /// tabs. Returns false when it is signed out and no account is set.
    @discardableResult
    func signInIfNeeded(timeout: TimeInterval = 30) -> Bool {
        if tabBars.firstMatch.waitForExistence(timeout: 8) { return true }
        guard E2EAccount.isConfigured, openLoginFromOnboarding() else { return false }
        let methodPicker = segmentedControls["login.methodPicker"]
        guard methodPicker.waitForExistence(timeout: 5) else { return false }
        methodPicker.buttons["Password"].tap()
        let emailField = textFields["login.emailField"]
        guard emailField.waitForExistence(timeout: 5) else { return false }
        emailField.tap()
        emailField.typeText(E2EAccount.email)
        let passwordField = secureTextFields["login.passwordField"]
        passwordField.tap()
        passwordField.typeText(E2EAccount.password)
        buttons["login.submitButton"].tap()
        return tabBars.firstMatch.waitForExistence(timeout: timeout)
    }
}
