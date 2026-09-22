import Foundation
import AMUXCore

// The three numbers on a person's profile.
//
// An agent's page counts what is installed on it — skills, MCP servers, env.
// A person has none of those: they do not install skills, and the env block
// showed the team's number, identical on everybody's page. What a person has
// is activity, so that is what this counts.

/// What a member did, for the stat row on their profile.
struct MemberActivityStats: Equatable {
    /// Tokens the leaderboard attributes to them over `tokenPeriod`.
    let tokens: Int
    /// Ideas they posted that are still on the board.
    let ideaCount: Int

    /// `day | week | month` — the only windows the leaderboard offers; there
    /// is no lifetime total to ask for.
    ///
    /// A month, because three numbers side by side read as "how much does this
    /// person do", and a day mostly reads zero. The label carries the window,
    /// since a bare token count invites being read as all-time.
    static let tokenPeriod = "month"
}

/// The blocks on a member's stat row, in display order.
enum MemberStatKind: CaseIterable {
    case tokens
    case ideas

    var title: String {
        switch self {
        case .tokens: String(localized: "Tokens")
        case .ideas: String(localized: "Ideas")
        }
    }

    /// The small tag under the number, for a block whose scope is not "this
    /// person, all time". Mirrors the `TEAM` tag on an agent's env block: three
    /// numbers side by side otherwise imply one scope.
    var scopeTag: String? {
        switch self {
        case .tokens: String(localized: "MONTH")
        case .ideas: nil
        }
    }

    func value(from stats: MemberActivityStats) -> String {
        switch self {
        case .tokens: formattedTokenCount(stats.tokens)
        case .ideas: "\(stats.ideaCount)"
        }
    }
}

/// Short enough for a third of a phone's width — a real token count runs to
/// seven digits and would otherwise shrink the whole row to fit.
func formattedTokenCount(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
    return "\(n)"
}

enum MemberActivityStatsLoader {
    /// Both numbers, fetched concurrently.
    ///
    /// A failing leg contributes 0 rather than failing the pair: one number
    /// missing is better than a row of dashes, and a team with no telemetry
    /// genuinely has no rows.
    static func load(
        teamID: String,
        actorID: String,
        telemetry: any TelemetryRepository,
        ideas: any IdeaRepository
    ) async -> MemberActivityStats {
        async let entries = try? telemetry.leaderboard(
            teamID: teamID,
            period: MemberActivityStats.tokenPeriod
        )
        async let records = try? ideas.listIdeas(teamID: teamID)
        return MemberActivityStats(
            tokens: tokens(in: await entries ?? [], for: actorID),
            ideaCount: ideaCount(in: await records ?? [], for: actorID)
        )
    }

    /// The leaderboard reports one row per actor that did anything in the
    /// window. Somebody who did nothing has no row, which is a real zero.
    static func tokens(in entries: [TeamLeaderboardEntry], for actorID: String) -> Int {
        guard let entry = entries.first(where: { $0.actorID == actorID }) else { return 0 }
        return Int(entry.tokensUsed)
    }

    /// Archived ideas are off the board, so they are not counted — this is
    /// "what they have up", not "what they have ever written".
    static func ideaCount(in records: [IdeaRecord], for actorID: String) -> Int {
        records.filter { $0.createdByActorID == actorID && !$0.archived }.count
    }
}
