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

    /// Sessions tab → New Session → the E2E agent as collaborator. Leaves the
    /// sheet open with the message field ready and returns it.
    func openNewSessionWithE2EAgent(file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let sessionsTab = tabBars.buttons["Sessions"]
        XCTAssertTrue(sessionsTab.waitForExistence(timeout: 20), "Sessions tab missing", file: file, line: line)
        sessionsTab.tap()

        let newSession = buttons["sessions.newSessionButton"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 15), "New Session button missing", file: file, line: line)
        newSession.tap()

        let collaborators = buttons["Just you"]
        XCTAssertTrue(collaborators.waitForExistence(timeout: 10), "Collaborators row missing", file: file, line: line)
        collaborators.tap()

        let agent = buttons.matching(NSPredicate(format: "label CONTAINS %@", E2EAccount.agentName)).firstMatch
        XCTAssertTrue(
            agent.waitForExistence(timeout: 15),
            "Agent \(E2EAccount.agentName) not in the picker\n\(debugDescription)",
            file: file, line: line
        )
        agent.tap()
        XCTAssertFalse(
            staticTexts["actorPicker.toast"].waitForExistence(timeout: 1),
            "Picker refused the agent: \(staticTexts["actorPicker.toast"].label)",
            file: file, line: line
        )

        let confirm = buttons["Confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Picker Confirm missing", file: file, line: line)
        confirm.tap()

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
