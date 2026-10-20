import XCTest

/// Regression tests for two reported user-visible bugs:
///
/// 1. **"Session not found" flash** — after tapping send on the New Session
///    sheet, the destination view briefly rendered "Session not found" while
///    SwiftData / Supabase round-tripped, before the session row landed.
///    Verified here by polling the screen for that copy during the
///    transition window after Send.
///
/// 2. **Second user message in a fresh session silently dropped** — sending
///    a follow-up in a session created moments earlier never reached the
///    daemon. Verified by sending two messages in a row and waiting for the
///    agent to answer both.
///
/// Both run against the E2E team's agent (see `E2EFlows.swift`).
final class AMUXSessionMessageRegressionTests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.signInIfNeeded(), "Not signed in and no E2E account configured")
    }

    override func tearDownWithError() throws {
        app = nil
    }

    // MARK: - Bug 1

    /// `SessionDestinationView` renders "Session not found" when its lookup
    /// hasn't resolved; the fix gates that copy behind `attemptedRefresh`,
    /// flipped only after the backend refresh and a follow-up load complete.
    /// Before the fix it flashed for the length of the round-trip.
    @MainActor
    func testSessionNotFoundCopyDoesNotFlashAfterCreatingSession() throws {
        let messageField = app.openNewSessionWithE2EAgent()
        let needle = "regression-bug1-\(Int(Date().timeIntervalSince1970))"
        messageField.tap()
        messageField.typeText(needle)
        let send = app.buttons["newSession.sendButton"]
        XCTAssertTrue(send.isEnabled)
        send.tap()

        let notFound = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@",
                        "Session not found", "Agent not found")
        ).firstMatch
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            if notFound.exists {
                let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                attachment.name = "bug1-not-found-flashed"
                attachment.lifetime = .keepAlways
                add(attachment)
                XCTFail("Bug 1 regression: '\(notFound.label)' flashed after Send.")
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    // MARK: - Bug 2

    /// Two messages in a row in a fresh session; the agent must answer both.
    /// Each answer is a sum absent from its own prompt, so finding it proves
    /// the daemon received that message.
    @MainActor
    func testTwoConsecutiveUserMessagesInFreshCollabSession() throws {
        let messageField = app.openNewSessionWithE2EAgent()
        app.sendNewSession("What is 1200 + 34? Reply with only the number.", in: messageField)
        XCTAssertTrue(
            app.element(containing: "1234").waitForExistence(timeout: 90),
            "First reply (1234) never arrived.\n\(app.debugDescription)"
        )

        app.sendFromComposer("What is 4300 + 21? Reply with only the number.")
        guard app.element(containing: "4321").waitForExistence(timeout: 90) else {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "bug2-second-reply-missing"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTFail("Bug 2 regression: the second message got no reply (4321).\n\(app.debugDescription)")
            return
        }
    }
}
