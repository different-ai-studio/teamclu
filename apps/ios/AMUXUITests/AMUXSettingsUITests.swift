import XCTest

/// Settings root: the current team and both default agents must be visible
/// without scrolling into sub-pages.
final class AMUXSettingsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSettingsShowsCurrentTeamAndDefaultAgents() throws {
        let app = XCUIApplication()
        app.launch()
        guard app.signInIfNeeded() else {
            throw XCTSkip("Signed out and no E2E account configured")
        }

        let shortcuts = app.buttons["sessions.shortcutsButton"]
        XCTAssertTrue(shortcuts.waitForExistence(timeout: 8))
        shortcuts.tap()
        let settings = app.descendants(matching: .any)["shortcuts.settingsButton"]
        if !settings.waitForExistence(timeout: 8) {
            attachScreenshot(app, name: "drawer-missing-settings")
            XCTFail("Settings entry not found in the shortcuts drawer")
        }
        settings.tap()

        XCTAssertTrue(app.buttons["settings.switchTeamButton"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["settings.memberDefaultAgentPicker"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["settings.teamDefaultAgentPicker"].exists)
        XCTAssertTrue(app.staticTexts["settings.defaultAgentFootnote"].waitForExistence(timeout: 10))
        attachScreenshot(app, name: "settings-root")

        // Open the personal picker to see its options, then back out
        // without choosing: the E2E account's defaults stay untouched.
        let memberPicker = app.buttons["settings.memberDefaultAgentPicker"]
        if memberPicker.exists {
            memberPicker.tap()
            sleep(1)
            attachScreenshot(app, name: "settings-member-picker")
            app.navigationBars.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
            sleep(1)
        }

        // Switch Team opens a sheet over Settings (no route flip); close it
        // without picking so the E2E account stays in its team.
        app.buttons["settings.switchTeamButton"].tap()
        let closeSwitch = app.buttons["teamSwitch.closeButton"]
        XCTAssertTrue(closeSwitch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'teamSwitch.row.'"))
            .firstMatch.waitForExistence(timeout: 10))
        attachScreenshot(app, name: "settings-team-switch-sheet")
        closeSwitch.tap()
        XCTAssertTrue(app.buttons["settings.switchTeamButton"].waitForExistence(timeout: 5))

        app.buttons["settings.teamInfoButton"].tap()
        XCTAssertTrue(app.navigationBars["Team Info"].waitForExistence(timeout: 5))
        attachScreenshot(app, name: "settings-team-info")
        app.navigationBars.buttons.firstMatch.tap()

        let notifications = app.buttons["Notifications"]
        if notifications.waitForExistence(timeout: 5) {
            notifications.tap()
            XCTAssertTrue(app.switches["notifications.pushToggle"].waitForExistence(timeout: 5))
            attachScreenshot(app, name: "settings-notifications")
        }
    }

    private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
