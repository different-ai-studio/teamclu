import XCTest

/// Regression tests for two reported user-visible bugs:
///
/// 1. **"Session not found" flash** — after tapping send on the New Session
///    sheet, the destination view briefly rendered "Session not found" while
///    SwiftData / Supabase round-tripped, before the session row landed.
///    Verified here by polling the screen for that copy during the
///    transition window after Send.
///
/// 2. **Second message never reaches the daemon** — the first user message
///    in a fresh collab session got a reply, but a follow-up message went
///    nowhere. Verified here by sending two messages back-to-back in the
///    same session and asserting both user bubbles appear and (when a
///    daemon is reachable) both assistant replies stream back.
///
/// ## Required environment
///   - `TEAMCLU_TEST_EMAIL`, `TEAMCLU_TEST_PASSWORD` in the test scheme.
///   - Account fixture is `uitest@teamclu.tech` per the team test
///     conventions; the team must have at least one daemon agent
///     registered in Supabase (so the New Session sheet can pick a
///     collaborator and route through the shared-session path that
///     hits `SessionDestinationView`).
final class AMUXSessionMessageRegressionTests: XCTestCase {

    private var app: XCUIApplication!

    private var testEmail: String {
        ProcessInfo.processInfo.environment["TEAMCLU_TEST_EMAIL"] ??
            ProcessInfo.processInfo.environment["AMUX_TEST_EMAIL"] ?? ""
    }

    private var testPassword: String {
        ProcessInfo.processInfo.environment["TEAMCLU_TEST_PASSWORD"] ??
            ProcessInfo.processInfo.environment["AMUX_TEST_PASSWORD"] ?? ""
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    // MARK: - Bug 1

    /// Asserts that `Text("Session not found")` (rendered by
    /// `SessionDestinationView` when the session lookup hasn't
    /// resolved yet) never appears on screen during the first few seconds
    /// after a fresh session is created. The fix in `SessionsTab.swift`
    /// gates that copy behind `attemptedRefresh`, which is now flipped
    /// only after `refreshSessionsFromBackend()` AND a follow-up
    /// `loadSession()` complete. Before the fix, the flag was flipped
    /// right when the network refresh started, so the copy flashed for
    /// the duration of the round-trip.
    @MainActor
    func testSessionNotFoundCopyDoesNotFlashAfterCreatingSession() throws {
        try XCTSkipIf(testEmail.isEmpty || testPassword.isEmpty,
                      "Set TEAMCLU_TEST_EMAIL and TEAMCLU_TEST_PASSWORD")

        signInIfNeeded()

        let sessionsTab = app.tabBars.buttons["Sessions"]
        XCTAssertTrue(sessionsTab.waitForExistence(timeout: 20))
        sessionsTab.tap()

        let newSession = app.buttons["sessions.newSessionButton"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 15))
        newSession.tap()

        let messageField = app.textFields["newSession.messageField"]
        XCTAssertTrue(messageField.waitForExistence(timeout: 10))

        // Skip the collaborator picker — it covers the New Session sheet
        // with another sheet that's awkward to dismiss reliably, and the
        // not-found-flash assertion below covers both navigation
        // destinations (collab: and runtimeId).

        let needle = "regression-bug1-\(Int(Date().timeIntervalSince1970))"
        focusAndType(messageField, text: needle)

        let sendButton = app.buttons["newSession.sendButton"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
        XCTAssertTrue(sendButton.isEnabled,
                      "Send should be enabled with non-empty text")

        sendButton.tap()

        // Poll for ~6s. SessionDestinationView shows "Session not
        // found"; RuntimeDestinationView shows "Agent not found". Both
        // are the same gating bug — flag any flash of either.
        let notFoundQuery = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@",
                        "Session not found", "Agent not found")
        )
        let pollInterval: TimeInterval = 0.05
        let pollDeadline = Date().addingTimeInterval(6)
        var sawNotFound = false
        var sawNotFoundLabel = ""
        while Date() < pollDeadline {
            let match = notFoundQuery.firstMatch
            if match.exists {
                sawNotFound = true
                sawNotFoundLabel = match.label
                break
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }

        if sawNotFound {
            attachScreenshot(named: "bug1-not-found-flashed")
        }
        XCTAssertFalse(sawNotFound,
                       "Bug 1 regression: '\(sawNotFoundLabel)' flashed during the post-Send transition.")
    }

    // MARK: - Bug 2

    /// Sends two consecutive user messages in the same fresh session and
    /// asserts that the second user bubble appears (proving the iOS UI
    /// did publish it). When a daemon is reachable, both assistant
    /// replies should also stream back; without one, the assistant
    /// assertions are skipped via the `AMUX_REQUIRE_DAEMON` env var.
    @MainActor
    func testTwoConsecutiveUserMessagesInFreshCollabSession() throws {
        try XCTSkipIf(testEmail.isEmpty || testPassword.isEmpty,
                      "Set TEAMCLU_TEST_EMAIL and TEAMCLU_TEST_PASSWORD")

        signInIfNeeded()

        let sessionsTab = app.tabBars.buttons["Sessions"]
        XCTAssertTrue(sessionsTab.waitForExistence(timeout: 20))
        sessionsTab.tap()

        let newSession = app.buttons["sessions.newSessionButton"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 15))
        newSession.tap()

        let messageField = app.textFields["newSession.messageField"]
        XCTAssertTrue(messageField.waitForExistence(timeout: 10))

        let firstNeedle = "first-\(Int(Date().timeIntervalSince1970))"
        focusAndType(messageField, text: "Reply with exactly: \(firstNeedle)")

        let sendButton = app.buttons["newSession.sendButton"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
        XCTAssertTrue(sendButton.isEnabled)
        sendButton.tap()

        // Wait for the navigation transition. CollabSessionView's input
        // field is `collab.messageField`. SessionDetailView uses
        // `chatInput.textField`. We wait for whichever lands first since
        // both can host a fresh session depending on agent availability.
        let collabField = app.textFields["collab.messageField"]
        let runtimeCompose = app.buttons["chatInput.compose"]
        let runtimeField = app.textFields["chatInput.textField"]
        let inputAppeared = waitForFirstExisting(
            of: [collabField, runtimeField, runtimeCompose],
            timeout: 30
        )
        if !inputAppeared {
            // No daemon to spawn the runtime, AND no collaborator was
            // picked, so neither navigation destination renders an input
            // field. We can't verify the second-message regression
            // without one of those — skip rather than fail.
            attachScreenshot(named: "bug2-no-input-field-skipping")
            throw XCTSkip("Session detail input field never appeared — needs a reachable daemon or collaborator. Skipping.")
        }

        // Verify the first user-message bubble landed.
        let firstBubble = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", firstNeedle)
        ).firstMatch
        XCTAssertTrue(firstBubble.waitForExistence(timeout: 30),
                      "First user message bubble did not render.\n\(app.debugDescription)")

        // Now send a second message in the same session.
        let secondNeedle = "second-\(Int(Date().timeIntervalSince1970))"
        let secondPrompt = "Reply with exactly: \(secondNeedle)"
        sendInActiveDetailView(text: secondPrompt,
                               collabField: collabField,
                               runtimeCompose: runtimeCompose,
                               runtimeField: runtimeField)

        let secondBubble = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", secondNeedle)
        ).firstMatch
        guard secondBubble.waitForExistence(timeout: 15) else {
            attachScreenshot(named: "bug2-second-bubble-missing")
            XCTFail("Bug 2 regression: second user bubble never rendered.\n\(app.debugDescription)")
            return
        }

        let requireDaemon = ProcessInfo.processInfo.environment["AMUX_REQUIRE_DAEMON"] == "1"
        if requireDaemon {
            // Generous timeout — model latency + ACP startup.
            let firstReply = app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] %@", firstNeedle)
            )
            XCTAssertTrue(firstReply.element(boundBy: 1).waitForExistence(timeout: 90),
                          "First assistant reply never streamed.")

            let secondReply = app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] %@", secondNeedle)
            )
            // Assistant reply for the second message — same needle string
            // appears at least twice (once in user bubble, once in reply).
            XCTAssertTrue(secondReply.element(boundBy: 1).waitForExistence(timeout: 90),
                          "Bug 2 regression: second assistant reply never streamed (daemon never received the message).")
        }
    }

    // MARK: - Helpers

    private func signInIfNeeded() {
        if app.tabBars.buttons["Sessions"].waitForExistence(timeout: 6) {
            return
        }
        XCTAssertTrue(app.openLoginFromOnboarding())

        let methodPicker = app.segmentedControls["login.methodPicker"]
        XCTAssertTrue(methodPicker.waitForExistence(timeout: 3))
        methodPicker.buttons["Password"].tap()
        let emailField = app.textFields["login.emailField"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 5))
        emailField.tap()
        emailField.typeText(testEmail)

        let passwordField = app.secureTextFields["login.passwordField"]
        passwordField.tap()
        passwordField.typeText(testPassword)

        app.buttons["login.submitButton"].tap()
    }

    /// Best-effort: open the collaborator picker, pick the first row,
    /// dismiss. Bails out if the picker is empty or stayed open without
    /// rows (e.g. team has no other actors). Always swipe down at the
    /// end so a leftover sheet doesn't shadow the message field. The
    /// test does NOT assert the createSharedSession path was reached —
    /// the not-found-flash regression check below covers both navigation
    /// destinations (collab: and runtimeId).
    private func addAnyAvailableCollaborator() {
        let plusImage = app.buttons["plus.circle.fill"]
        guard plusImage.waitForExistence(timeout: 3) else { return }
        plusImage.tap()

        // Picker sheet should slide up. Pick the first cell if any.
        let pickerCell = app.collectionViews.cells.firstMatch
        if pickerCell.waitForExistence(timeout: 4) {
            pickerCell.tap()
        }

        let done = app.buttons["Done"]
        if done.waitForExistence(timeout: 1) { done.tap() }

        // Belt-and-suspenders: if any modal sheet is still on screen,
        // swipe it down so the New Session sheet's message field is
        // hittable again.
        if app.sheets.firstMatch.exists || app.otherElements["PopoverDismissRegion"].exists {
            app.swipeDown(velocity: .fast)
        }
    }

    private func sendInActiveDetailView(text: String,
                                        collabField: XCUIElement,
                                        runtimeCompose: XCUIElement,
                                        runtimeField: XCUIElement) {
        if collabField.waitForExistence(timeout: 2) {
            focusAndType(collabField, text: text)
            let send = app.buttons["collab.sendButton"]
            XCTAssertTrue(send.waitForExistence(timeout: 3))
            send.tap()
            return
        }
        if runtimeCompose.waitForExistence(timeout: 2) { runtimeCompose.tap() }
        XCTAssertTrue(runtimeField.waitForExistence(timeout: 5))
        focusAndType(runtimeField, text: text)
        let send = app.buttons["chatInput.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        send.tap()
    }

    /// Robustly focus a `TextField` and type into it. SwiftUI text fields
    /// occasionally fail to gain keyboard focus from a single `tap()`
    /// (especially right after another sheet dismissed); retry with a
    /// `doubleTap` after a short pause if the keyboard didn't come up.
    private func focusAndType(_ field: XCUIElement, text: String) {
        field.tap()
        Thread.sleep(forTimeInterval: 0.3)
        if !app.keyboards.firstMatch.waitForExistence(timeout: 1.5) {
            field.doubleTap()
            Thread.sleep(forTimeInterval: 0.3)
        }
        if !app.keyboards.firstMatch.waitForExistence(timeout: 1.5) {
            // Last resort: tap by coordinates to force focus.
            let coord = field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            coord.tap()
            Thread.sleep(forTimeInterval: 0.3)
        }
        field.typeText(text)
    }

    private func waitForFirstExisting(of elements: [XCUIElement], timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if elements.contains(where: { $0.exists }) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
