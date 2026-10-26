import XCTest

/// Autonomous diagnostic test for the session/{id}/live event-routing rewrite.
/// Assumes the simulator is already signed in (uses persistent keychain). Drives
/// the chat input on the first existing session and waits for the assistant's
/// reply. Captures DIAG NSLogs from RuntimeDetailVM-DIAG2 and daemon-side
/// `ACPDIAG:` traces for offline analysis.
final class AMUXSessionLiveDiagTest: XCTestCase {

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
    func testSendPromptInExistingSession() throws {
        // Currently blocked by gap #2 in AMUXSessionStreamingUITests.swift
        // (pairing.deviceId empty -> SessionListVM never subscribes to
        // runtime/+/state -> Runtime row's `availableModels` stays empty and
        // `isIdle` never flips true). Without that, ReplySheet's send button
        // is permanently disabled (`canSend` requires `!isDisabled`), so this
        // test cannot exercise the assistant-reply flow end-to-end. Re-enable
        // once SessionListVM is rewired to discover daemon device_ids via
        // ConnectedAgentsStore (the cleanup tracked in the next PR).
        try XCTSkipIf(ProcessInfo.processInfo.environment["AMUX_RUN_SESSION_LIVE_DIAG"] != "1",
                      "Skipped pending follow-up that unblocks ReplySheet send button. Set AMUX_RUN_SESSION_LIVE_DIAG=1 to run anyway.")

        XCTAssertTrue(app.waitForHome(timeout: 15),
                      "Session list not visible — app may not be signed in.\n\(app.debugDescription)")

        // boundBy(0) is the "Yesterday" section header; (1) is the first
        // actual session row.
        let cells = app.collectionViews.cells
        XCTAssertTrue(cells.element(boundBy: 0).waitForExistence(timeout: 10),
                      "No collection cells.\n\(app.debugDescription)")
        let sessionCell = cells.element(boundBy: 1)
        XCTAssertTrue(sessionCell.exists,
                      "No second cell (session row).\n\(app.debugDescription)")
        sessionCell.tap()

        // Try collab (TextField) first, then fall back to runtime (compose icon -> text field).
        var sentVia = ""
        let needle = "diag-\(Int(Date().timeIntervalSince1970))"
        let prompt = "Reply with exactly: \(needle)"

        let collabField = app.textFields["collab.messageField"]
        if collabField.waitForExistence(timeout: 5) {
            collabField.tap()
            collabField.typeText(prompt)
            let collabSend = app.buttons["collab.sendButton"]
            XCTAssertTrue(collabSend.waitForExistence(timeout: 3))
            collabSend.tap()
            sentVia = "collab"
        } else {
            let composeButton = app.buttons["chatInput.compose"]
            if composeButton.waitForExistence(timeout: 5) { composeButton.tap() }
            let runtimeField = app.textFields["chatInput.textField"]
            XCTAssertTrue(runtimeField.waitForExistence(timeout: 5),
                          "No input field found (collab nor runtime).\n\(app.debugDescription)")
            runtimeField.tap()
            runtimeField.typeText(prompt)
            let sendButton = app.buttons["chatInput.send"]
            XCTAssertTrue(sendButton.waitForExistence(timeout: 3))
            XCTAssertTrue(sendButton.isEnabled, "Send disabled.\n\(app.debugDescription)")
            sendButton.tap()
            sentVia = "runtime"
        }
        NSLog("[DIAG-TEST] sent prompt via %@ path with needle=%@", sentVia, needle)

        let predicate = NSPredicate(format: "label CONTAINS[c] %@", needle)
        let streamedText = app.staticTexts.matching(predicate).firstMatch
        let saw = streamedText.waitForExistence(timeout: 90)

        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = saw ? "session-live-success-\(sentVia)" : "session-live-failure-\(sentVia)"
        attachment.lifetime = .keepAlways
        add(attachment)

        XCTAssertTrue(saw,
                      "Did not see assistant output containing \(needle.debugDescription) within 90s (sent via \(sentVia)).\n\(app.debugDescription)")
    }
}
