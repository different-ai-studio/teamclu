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
