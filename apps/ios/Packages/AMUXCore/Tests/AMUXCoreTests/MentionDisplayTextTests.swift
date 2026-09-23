import XCTest
@testable import AMUXCore

final class MentionDisplayTextTests: XCTestCase {
    typealias S = MentionDisplayText.Segment

    func test_plainMessage_isUntouched() {
        XCTAssertEqual(MentionDisplayText.segments("hello\nworld"), [S(.text, "hello\nworld")])
    }

    func test_leadingAgentLine_becomesMention() {
        XCTAssertEqual(
            MentionDisplayText.segments("[Mentioned agents: SPRBOT]\n\n深圳宝安有什么推荐的美食?"),
            [S(.mention, "@SPRBOT"), S(.text, " 深圳宝安有什么推荐的美食?")]
        )
    }

    func test_leadingLine_listsSeveral() {
        XCTAssertEqual(
            MentionDisplayText.segments("[Mentioned agents: A, B]\n[Mentioned humans: C]\nhi"),
            [S(.mention, "@A"), S(.text, " "), S(.mention, "@B"), S(.text, " "), S(.mention, "@C"), S(.text, " hi")]
        )
    }

    /// The message in the report: an agent line plus a human chip, no body.
    func test_mentionsOnly_dropInstructionAndScaffolding() {
        let raw = "[Mentioned agents: 研小蕉 Bot]\n\n[Mentioned: 周金亮 |instruction: 这条信息还提及了人类 周金亮]"
        XCTAssertEqual(
            MentionDisplayText.segments(raw),
            [S(.mention, "@研小蕉 Bot"), S(.text, " "), S(.mention, "@周金亮")]
        )
        XCTAssertEqual(MentionDisplayText.plainText(raw), "@研小蕉 Bot @周金亮")
    }

    func test_inlineHumanChip_midSentence() {
        XCTAssertEqual(
            MentionDisplayText.segments("[Mentioned: Haigang Ye|instruction: 提及 Haigang Ye] 帮我看下结算"),
            [S(.mention, "@Haigang Ye"), S(.text, " 帮我看下结算")]
        )
    }

    func test_skillAndRoleChips_becomeInvocations() {
        let raw = "[Skill: issue-normalizer|instruction:You must call skill({ name: \"issue-normalizer\" }) before any other action.] fix [Role: reviewer|instruction:x]"
        XCTAssertEqual(
            MentionDisplayText.segments(raw),
            [S(.invocation, "/issue-normalizer"), S(.text, " fix "), S(.invocation, "/reviewer")]
        )
    }

    func test_ordinaryBrackets_areLeftAlone() {
        XCTAssertEqual(
            MentionDisplayText.segments("see [docs] and [Mentioned agents: x] later"),
            [S(.text, "see [docs] and [Mentioned agents: x] later")]
        )
    }
}
