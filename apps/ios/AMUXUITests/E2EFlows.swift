import XCTest

/// Flows shared by the E2E tests, written against the current UI: a new
/// session needs at least one collaborator, and the E2E team's one agent
/// (`E2EAccount.agentName`) is the one they pick.
extension E2EAccount {
    /// Display name of the agent in the E2E team; override with
    /// `TEAMCLU_TEST_AGENT` when running against another team.
    static var agentName: String {
        ProcessInfo.processInfo.environment["TEAMCLU_TEST_AGENT"] ?? "ios-e2e-agent"
    }
}

extension XCUIApplication {
    /// Taps `target` until `expected` shows. Right after launch the app is
    /// still settling (list refresh, MQTT connect) and a tap can be dropped.
    @discardableResult
    func tap(_ target: XCUIElement, until expected: XCUIElement, attempts: Int = 3) -> Bool {
        for _ in 0..<attempts {
            if target.waitForExistence(timeout: 5) { target.tap() }
            if expected.waitForExistence(timeout: 5) { return true }
        }
        return false
    }

    /// Any element whose label contains `text` — message bubbles can be
    /// merged into one accessibility element, so exact static texts miss.
    func element(containing text: String) -> XCUIElement {
        descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text))
            .firstMatch
    }

    func countOfElements(containing text: String) -> Int {
        descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text))
            .count
    }

    /// Session list bottom bar → New Session → the E2E agent as the
    /// session's agent. Leaves the sheet open with the message field ready
    /// and returns it.
    func openNewSessionWithE2EAgent(file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let composer = homeComposerField
        XCTAssertTrue(waitForHome(timeout: 20), "Session list bottom bar missing", file: file, line: line)
        composer.tap()

        let agentRow = buttons["newSession.agentRow"]
        XCTAssertTrue(agentRow.waitForExistence(timeout: 10), "Agent row missing", file: file, line: line)
        agentRow.tap()

        let agent = buttons.matching(NSPredicate(format: "label CONTAINS %@", E2EAccount.agentName)).firstMatch
        XCTAssertTrue(
            agent.waitForExistence(timeout: 15),
            "Agent \(E2EAccount.agentName) not in the agent menu\n\(debugDescription)",
            file: file, line: line
        )
        agent.tap()

        // The agent is seated once its workspaces load and the row shows one.
        let workspaceRow = buttons["newSession.workspaceRow"]
        XCTAssertTrue(workspaceRow.waitForExistence(timeout: 5), "Workspace row missing", file: file, line: line)
        XCTAssertTrue(
            workspaceRow.wait(for: \.isEnabled, toEqual: true, timeout: 15),
            "Agent \(E2EAccount.agentName) has no workspace\n\(debugDescription)",
            file: file, line: line
        )

        let messageField = textFields["newSession.messageField"]
        XCTAssertTrue(messageField.waitForExistence(timeout: 10), "Message field missing", file: file, line: line)
        return messageField
    }

    /// Types into the new-session field and sends. Lands in session detail.
    func sendNewSession(_ text: String, in messageField: XCUIElement,
                        file: StaticString = #filePath, line: UInt = #line) {
        messageField.tap()
        messageField.typeText(text)
        let send = buttons["newSession.sendButton"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), file: file, line: line)
        XCTAssertTrue(send.isEnabled, "Send disabled with text and an agent picked", file: file, line: line)
        send.tap()
        XCTAssertTrue(
            textFields["composer.textField"].waitForExistence(timeout: 20),
            "Session detail never opened after Send\n\(debugDescription)",
            file: file, line: line
        )
    }

    /// Sends a follow-up from the session detail composer.
    func sendFromComposer(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        let field = textFields["composer.textField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), file: file, line: line)
        field.tap()
        field.typeText(text)
        let send = buttons["composer.sendButton"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "Composer send button missing", file: file, line: line)
        send.tap()
    }
}
