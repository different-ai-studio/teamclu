import Foundation
import Testing
import AMUXCore
@testable import AMUXUI

/// Picking one person's numbers out of team-wide answers.
///
/// Both sources return the whole team: the leaderboard has a row per actor,
/// and the idea list is every idea in the team. Selecting the wrong rows here
/// is silent — the profile still shows two plausible numbers.
@Suite("Member activity stats")
struct MemberActivityStatsTests {
    private func entry(_ actorID: String, tokens: Double) -> TeamLeaderboardEntry {
        TeamLeaderboardEntry(
            actorID: actorID,
            displayName: nil,
            tokensUsed: tokens,
            costUsd: 0,
            sessionCount: 0,
            positiveFeedback: 0,
            negativeFeedback: 0,
            skillUsage: [:]
        )
    }

    /// `createdAt` is derived from the name so the ordering assertion below
    /// has something to order by: "newer" sorts after "older" alphabetically,
    /// and the feed wants it first.
    private func idea(_ id: String, by actorID: String, archived: Bool = false) -> IdeaRecord {
        let created = Date(timeIntervalSince1970: id == "newer" ? 2_000 : 1_000)
        return IdeaRecord(
            id: id,
            teamID: "team-1",
            workspaceID: "ws-1",
            createdByActorID: actorID,
            title: id,
            description: "",
            status: "open",
            archived: archived,
            createdAt: created,
            updatedAt: created
        )
    }

    @Test("takes this actor's row, not the first or the biggest")
    func picksTheRightRow() {
        let entries = [entry("other", tokens: 9_000), entry("me", tokens: 120)]
        #expect(MemberActivityStatsLoader.tokens(in: entries, for: "me") == 120)
    }

    @Test("no row is a real zero — somebody who did nothing is simply absent")
    func absentIsZero() {
        #expect(MemberActivityStatsLoader.tokens(in: [entry("other", tokens: 5)], for: "me") == 0)
        #expect(MemberActivityStatsLoader.tokens(in: [], for: "me") == 0)
    }

    @Test("counts only this person's ideas, and only the ones still on the board")
    func countsOwnLiveIdeas() {
        let records = [
            idea("a", by: "me"),
            idea("b", by: "me", archived: true),
            idea("c", by: "someone-else"),
            idea("d", by: "me"),
        ]
        #expect(MemberActivityStatsLoader.ideaCount(in: records, for: "me") == 2)
    }

    @Test("the window is a month, because that is the label the row carries")
    func periodMatchesTheLabel() {
        #expect(MemberActivityStats.tokenPeriod == "month")
        #expect(MemberStatKind.tokens.scopeTag != nil)
        // Ideas are all-time and this person's own, so no tag to qualify them.
        #expect(MemberStatKind.ideas.scopeTag == nil)
    }

    @Test("the list behind the number shows exactly what the number counted")
    func listAgreesWithCount() {
        let records = [
            idea("older", by: "me"),
            idea("archived", by: "me", archived: true),
            idea("theirs", by: "someone-else"),
            idea("newer", by: "me"),
        ]
        let listed = MemberActivityStatsLoader.ideas(in: records, by: "me")
        #expect(listed.count == MemberActivityStatsLoader.ideaCount(in: records, for: "me"))
        #expect(listed.map(\.id) == ["newer", "older"])
    }

    @Test("only the ideas block opens anything")
    func onlyIdeasPushes() {
        #expect(MemberStatKind.ideas.opensList)
        #expect(!MemberStatKind.tokens.opensList)
    }

    @Test("a seven-digit token count is shortened, so a third of a phone fits it", arguments: [
        (0, "0"),
        (999, "999"),
        (1_000, "1.0K"),
        (12_345, "12.3K"),
        (999_999, "1000.0K"),
        (1_000_000, "1.0M"),
        (2_400_000, "2.4M"),
    ])
    func shortensLargeCounts(input: Int, expected: String) {
        #expect(formattedTokenCount(input) == expected)
    }
}
