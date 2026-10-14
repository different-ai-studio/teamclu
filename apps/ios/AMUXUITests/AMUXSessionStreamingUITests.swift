import XCTest

/// End-to-end: sign in → New Session with the E2E agent → the agent's reply
/// streams back into the session detail.
///
/// Covers the whole path — Cloud API auth, MQTT, the daemon receiving the
/// prompt, pi answering, and the reply rendering.
///
/// ## Required environment
///
///   - `TEAMCLU_TEST_EMAIL` / `TEAMCLU_TEST_PASSWORD`: an account whose team
///     has the agent `E2EAccount.agentName` (default `ios-e2e-agent`).
///   - That agent's daemon running, with a workspace, and the team able to
///     reach an LLM.
final class AMUXSessionStreamingUITests: XCTestCase {

    private var app: XCUIApplication!

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
        XCTAssertTrue(app.signInIfNeeded(), "Not signed in and no E2E account configured")

        let messageField = app.openNewSessionWithE2EAgent()
        // The answer is not in the prompt, so finding it means the agent replied.
        app.sendNewSession("What is 1234 + 4321? Reply with only the number.", in: messageField)

        guard app.element(containing: "5555").waitForExistence(timeout: 90) else {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "streaming-failure"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("No agent reply containing 5555 within 90s.\n\(app.debugDescription)")
            return
        }
    }
}
