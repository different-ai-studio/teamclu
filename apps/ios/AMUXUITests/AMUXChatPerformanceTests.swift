import XCTest

/// Regression reference for the IM-parity plan: M1 (open a session) and M2
/// (render a streamed turn), measured on the local perf fixtures so every run
/// sees the same 220-row session and the same scripted turn, with no network
/// or daemon in the measured path.
///
/// The numbers are the os_signpost intervals `ChatMetrics` emits
/// (subsystem `com.teamclu.mobile`, category `ChatMetrics`). Signs in with
/// the E2E account when needed: fixtures are installed when the app reaches
/// its ready route.
final class AMUXChatPerformanceTests: XCTestCase {
    private let largeSessionTitle = "Perf · large (220)"
    /// The newest history turn's heading: only in the detail feed, unlike
    /// the reply tail, which the list row also shows as its preview.
    private let detailOnlyText = "Turn 109: findings"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func signpost(_ name: String) -> XCTOSSignpostMetric {
        XCTOSSignpostMetric(subsystem: "com.teamclu.mobile", category: "ChatMetrics", name: name)
    }

    private func launch(replay: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-AMUXPerfFixtures", "YES"]
        if replay { app.launchArguments += ["-AMUXPerfReplay", "YES"] }
        app.launch()
        return app
    }

    private func largeSessionRow(in app: XCUIApplication) -> XCUIElement {
        XCTAssertTrue(app.signInIfNeeded(), "Not signed in and no E2E account configured")
        let row = app.staticTexts[largeSessionTitle]
        XCTAssertTrue(
            row.waitForExistence(timeout: 30),
            "Perf fixture session never appeared — is the simulator signed in to a team?"
        )
        return row
    }

    /// Reply bubbles can be merged into one accessibility element, so match
    /// on a label fragment rather than an exact static text.
    private func element(containing text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text))
            .firstMatch
    }

    /// Taps the row until the detail screen's composer shows. A tap that
    /// lands while the list is still settling after launch is swallowed.
    private func open(_ row: XCUIElement, in app: XCUIApplication) {
        let composer = app.descendants(matching: .any)["composer.textField"]
        for _ in 0..<3 {
            row.tap()
            if composer.waitForExistence(timeout: 5) { return }
        }
        XCTFail("Session detail never opened.\n\(app.debugDescription)")
    }

    /// Edge swipe: the detail screen's back control carries no stable label.
    private func goBack(in app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    /// M1 on the 220-row fixture: push → cached feed on screen.
    func testOpenLargeSession() throws {
        let app = launch(replay: false)
        let row = largeSessionRow(in: app)

        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [signpost("open_session")], options: options) {
            open(row, in: app)
            XCTAssertTrue(element(containing: detailOnlyText, in: app).waitForExistence(timeout: 15))
            // The accessibility tree can show the row a moment before the
            // first frame is marked; leaving then cuts the interval off.
            Thread.sleep(forTimeInterval: 0.5)
            goBack(in: app)
            XCTAssertTrue(row.waitForExistence(timeout: 10))
        }
    }

    /// M2 on the 220-row fixture: a scripted turn (thinking, 6 tool calls,
    /// 120 output deltas at 25 ms) streamed through the live-envelope path.
    /// Relaunches per iteration: a replayed turn stays in the session until
    /// the fixtures are rebuilt at launch, and its ending would otherwise
    /// satisfy the next iteration's wait before its own turn is done. Only
    /// the `turn_render` interval is measured, so launch time is not counted.
    func testStreamTurnOnLargeSession() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-AMUXPerfFixtures", "YES", "-AMUXPerfReplay", "YES"]

        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [signpost("turn_render")], options: options) {
            app.launch()
            open(largeSessionRow(in: app), in: app)
            XCTAssertTrue(
                element(containing: "Live replay finished.", in: app).waitForExistence(timeout: 30),
                "Replayed turn never appeared.\n\(app.debugDescription)"
            )
        }
    }
}
