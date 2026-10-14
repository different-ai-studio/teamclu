import XCTest

final class AMUXUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// New Session with the E2E agent lands in that session's detail, titled
    /// by the prompt.
    @MainActor
    func testNewSessionNavigatesToFreshAgentDetail() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.signInIfNeeded(), "Not signed in and no E2E account configured")

        let messageField = app.openNewSessionWithE2EAgent()
        let prompt = "UITest \(UUID().uuidString.prefix(8))"
        app.sendNewSession(prompt, in: messageField)

        guard app.element(containing: prompt).waitForExistence(timeout: 25) else {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "new-session-agent-failure"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("Expected the prompt \(prompt) in the new session's detail.\n\(app.debugDescription)")
            return
        }
    }
}
