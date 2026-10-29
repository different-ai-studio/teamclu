import XCTest

extension XCUIApplication {
    /// Signed out → LoginView: past the intro cards (first install only) and
    /// the join/create choice. False when neither screen shows up — usually
    /// because the app is already signed in.
    @discardableResult
    func openLoginFromOnboarding(timeout: TimeInterval = 6) -> Bool {
        skipIntroIfShown(timeout: timeout)
        let join = buttons["onboarding.joinButton"]
        guard join.waitForExistence(timeout: 3) else { return false }
        join.tap()
        return true
    }

    /// First install only: "Skip" leaves the intro from any card but the
    /// last, which offers "Get Started" instead.
    func skipIntroIfShown(timeout: TimeInterval = 6) {
        let skip = buttons["welcome.skipButton"]
        let getStarted = buttons["welcome.getStartedButton"]
        let join = buttons["onboarding.joinButton"]
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !skip.exists, !getStarted.exists, !join.exists {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        if skip.exists {
            skip.tap()
        } else if getStarted.exists {
            getStarted.tap()
        }
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
    /// The session list's bottom bar field — only on screen once the app is
    /// signed in and in a team, so it doubles as the "home" signal.
    var homeComposerField: XCUIElement { buttons["sessions.composerField"] }

    /// Waits for the session list to be on screen *and* usable. The launch
    /// splash sits over it for a moment after its controls already exist,
    /// swallowing taps — so existence alone isn't enough.
    func waitForHome(timeout: TimeInterval) -> Bool {
        guard homeComposerField.waitForExistence(timeout: timeout) else { return false }
        let splash = descendants(matching: .any)["app.splash"]
        return splash.waitForNonExistence(timeout: 10)
    }

    /// Opens one of the session list's top-right menu entries, e.g.
    /// `"sessions.menu.members"`.
    func openHomeMenuItem(_ identifier: String, timeout: TimeInterval = 8) -> Bool {
        let menu = buttons["sessions.menuButton"]
        guard waitForHome(timeout: timeout), menu.waitForExistence(timeout: 5) else { return false }
        menu.tap()
        let item = buttons[identifier]
        guard item.waitForExistence(timeout: 5) else { return false }
        item.tap()
        return true
    }

    /// Signs in with the E2E account unless the app already shows the
    /// session list. Returns false when it is signed out and no account is set.
    @discardableResult
    func signInIfNeeded(timeout: TimeInterval = 30) -> Bool {
        if waitForHome(timeout: 8) { return true }
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
        return waitForHome(timeout: timeout)
    }
}
