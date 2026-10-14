import XCTest
@testable import AMUXCore

final class NotificationPreviewTests: XCTestCase {
    func testDropsMarkdownMarks() {
        let text = "## Result\n\n**Done**: see [the PR](https://x/1) and `make test`.\n\n- one\n- two"
        XCTAssertEqual(NotificationPreview.plain(text), "Result\nDone: see the PR and make test.\n• one\n• two")
    }

    func testCodeFencesKeepTheCode() {
        XCTAssertEqual(NotificationPreview.plain("```swift\nlet x = 1\n```"), "let x = 1")
    }

    func testMentionScaffoldingReadsAsDisplayed() {
        let raw = "[Mentioned agents: oect-matt]\n\nship it"
        XCTAssertEqual(NotificationPreview.plain(raw), MentionDisplayText.plainText(raw))
        XCTAssertFalse(NotificationPreview.plain(raw).contains("[Mentioned"))
    }

    func testLeavesArithmeticAndSnakeCaseAlone() {
        XCTAssertEqual(NotificationPreview.plain("2 * 3 * 4 in my_var_name"), "2 * 3 * 4 in my_var_name")
    }

    func testTruncatesWithEllipsis() {
        XCTAssertEqual(NotificationPreview.plain(String(repeating: "a", count: 10), limit: 4), "aaaa…")
    }

    @MainActor
    func testLastLineSkipsTrailingBlanks() {
        XCTAssertEqual(TurnActivityCenter.lastLine(of: "Reading files\n**Running tests**\n\n"), "Running tests")
        XCTAssertNil(TurnActivityCenter.lastLine(of: "  \n"))
    }

    @MainActor
    func testSummaryIsTheAnswersStartOnOneLine() {
        XCTAssertEqual(TurnActivityCenter.summary(of: "**Fixed.**\n\nThe test was racing.\nLet me know."),
                       "Fixed. The test was racing. Let me know.")
        XCTAssertNil(TurnActivityCenter.summary(of: "   "))
    }
}
