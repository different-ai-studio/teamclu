import XCTest

/// Stage-three conversation actions against the E2E team's agent: replying
/// with a quote, and finding a message in the conversation.
final class AMUXConversationActionsUITests: XCTestCase {

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

    /// Long-press an agent answer → Reply → the bar names it → send. The
    /// agent answering "double it" with 2468 proves the reply reached it;
    /// the quoted 1234 showing above the prompt proves the quote rendered.
    @MainActor
    func testQuotedReplyToAnAgentAnswer() throws {
        let field = app.openNewSessionWithE2EAgent()
        app.sendNewSession("What is 1200 + 34? Reply with only the number.", in: field)
        let answer = app.staticTexts.matching(NSPredicate(format: "label == %@", "1234")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 90), "Answer (1234) never arrived.\n\(app.debugDescription)")

        // Reply needs the answer's row id, which follows the streamed text
        // by a moment (the daemon's persisted message.created). Reopen the
        // menu until it is there.
        let reply = app.buttons["Reply"]
        var offered = false
        for _ in 0..<8 where !offered {
            answer.press(forDuration: 1.2)
            offered = reply.waitForExistence(timeout: 2)
            if !offered {
                app.navigationBars.firstMatch.tap()
                sleep(2)
            }
        }
        XCTAssertTrue(offered, "No Reply in the message menu.\n\(app.debugDescription)")
        reply.tap()
        XCTAssertTrue(app.otherElements["composer.replyBar"].waitForExistence(timeout: 5)
                      || app.element(containing: "Replying to").waitForExistence(timeout: 1),
                      "Reply bar did not appear above the composer.")

        app.sendFromComposer("Double it. Reply with only the number.")
        XCTAssertTrue(
            app.element(containing: "2468").waitForExistence(timeout: 90),
            "The agent never answered the reply (2468).\n\(app.debugDescription)"
        )
        XCTAssertGreaterThanOrEqual(
            app.countOfElements(containing: "1234"), 2,
            "Quoted 1234 not shown above the reply.\n\(app.debugDescription)"
        )
        XCTAssertFalse(app.element(containing: "Replying to").exists, "Reply bar stayed up after sending.")
    }

    /// Session options → Search in Conversation → a query matching the
    /// prompt lands on the newest match, and Done closes the bar.
    @MainActor
    func testSearchInConversationFindsAMessage() throws {
        let needle = "findme\(Int(Date().timeIntervalSince1970) % 100000)"
        let field = app.openNewSessionWithE2EAgent()
        app.sendNewSession("\(needle) — just say ok.", in: field)

        let options = app.buttons["Session options"]
        XCTAssertTrue(options.waitForExistence(timeout: 15), "Session options menu missing")
        options.tap()
        let search = app.buttons["session.searchMenuItem"].exists
            ? app.buttons["session.searchMenuItem"] : app.buttons["Search in Conversation"]
        XCTAssertTrue(search.waitForExistence(timeout: 5), "No search entry in the menu.\n\(app.debugDescription)")
        search.tap()

        let query = app.textFields["sessionSearch.field"]
        XCTAssertTrue(query.waitForExistence(timeout: 5), "Search field missing")
        query.typeText(needle)
        let count = app.staticTexts["sessionSearch.count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5), "Match count missing")
        // The prompt matches; the agent's answer may repeat the word. Either
        // way the search opens on the newest match: "n/n".
        let parts = count.label.split(separator: "/").compactMap { Int($0) }
        XCTAssertEqual(parts.count, 2, "Unexpected count label: \(count.label)")
        XCTAssertGreaterThanOrEqual(parts.first ?? 0, 1)
        XCTAssertEqual(parts.first, parts.last, "Search did not start at the newest match: \(count.label)")

        app.buttons["sessionSearch.done"].tap()
        XCTAssertFalse(query.waitForExistence(timeout: 2), "Search bar stayed after Done")
    }
}
