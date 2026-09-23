import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

// MARK: - TeamStatsSheet

/// Team-wide statistics sheet. Opened from the leading toolbar button in
/// MembersTab. Shows token consumption, session count, and skills invocations
/// across the whole team, plus a per-actor token ranking and a skills
/// breakdown — all served by `GET /v1/teams/:id/leaderboard`, the same
/// aggregates the desktop leaderboard reads. No fabricated numbers: while
/// loading it shows a spinner, and a team with no telemetry shows zeros.
struct TeamStatsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppOnboardingCoordinator.self) private var onboarding: AppOnboardingCoordinator?
    let actors: [CachedActor]
    let teamID: String?

    enum Period: String, CaseIterable {
        case today = "Today"
        case week  = "Week"
        case month = "Month"

        var apiValue: String {
            switch self {
            case .today: return "day"
            case .week: return "week"
            case .month: return "month"
            }
        }

        /// Separate from `rawValue`, which doubles as enum identity.
        var displayName: String {
            switch self {
            case .today: return String(localized: "Today")
            case .week: return String(localized: "Week")
            case .month: return String(localized: "Month")
            }
        }
    }

    @State private var period: Period = .week
    @State private var entries: [TeamLeaderboardEntry] = []
    @State private var isLoading = false
    @State private var loadError: String?

    private var actorsByID: [String: CachedActor] {
        Dictionary(actors.map { ($0.actorId, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private struct ActorStat: Identifiable {
        let id: String
        let name: String
        let isAgent: Bool
        let agentType: String?
        let tokens: Int
    }

    private var actorStats: [ActorStat] {
        entries
            .map { entry in
                let cached = actorsByID[entry.actorID]
                return ActorStat(
                    id: entry.actorID,
                    name: cached?.displayName ?? entry.displayName ?? String(entry.actorID.prefix(8)),
                    isAgent: cached?.isAgent ?? false,
                    agentType: cached?.defaultAgentType,
                    tokens: Int(entry.tokensUsed)
                )
            }
            .sorted { $0.tokens > $1.tokens }
    }

    private var totalTokens: Int { entries.reduce(0) { $0 + Int($1.tokensUsed) } }
    private var totalSessions: Int { entries.reduce(0) { $0 + $1.sessionCount } }
    private var totalSkills: Int {
        entries.reduce(0) { $0 + $1.skillUsage.values.reduce(0, +) }
    }

    private struct SkillStat: Identifiable {
        var id: String { name }
        let name: String
        let count: Int
    }

    private var topSkills: [SkillStat] {
        var merged: [String: Int] = [:]
        for entry in entries {
            for (skill, count) in entry.skillUsage {
                merged[skill, default: 0] += count
            }
        }
        return merged
            .map { SkillStat(name: $0.key, count: $0.value) }
            .sorted { $0.count > $1.count }
            .prefix(5)
            .map { $0 }
    }

    private var maxSkillCount: Int { max(1, topSkills.map(\.count).max() ?? 1) }

    // MARK: Body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    periodPicker
                    if isLoading && entries.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 180)
                    } else if let loadError {
                        ContentUnavailableView(
                            "Stats Unavailable",
                            systemImage: "chart.bar",
                            description: Text(loadError)
                        )
                        .frame(minHeight: 180)
                    } else {
                        summaryRow
                        if !actorStats.isEmpty {
                            rankingSection
                        }
                        if !topSkills.isEmpty {
                            skillsSection
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .background(Color.amux.mist)
            .navigationTitle("Team Statistics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.amux.onyx)
                }
            }
            .task(id: period) { await load() }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func load() async {
        guard let teamID, !teamID.isEmpty,
              let onboarding,
              let config = CloudAPIConfigurationStore.configuration()
        else {
            loadError = String(localized: "Team stats need a signed-in Cloud API session.")
            return
        }
        isLoading = true
        loadError = nil
        defer { isLoading = false }

        let client = CloudAPIClient(configuration: config, accessToken: {
            try await onboarding.accessToken()
        })
        let repo = CloudAPITelemetryRepository(client: client)
        do {
            entries = try await repo.leaderboard(teamID: teamID, period: period.apiValue)
        } catch {
            entries = []
            loadError = error.localizedDescription
        }
    }

    // MARK: Period picker

    private var periodPicker: some View {
        Picker("Period", selection: $period) {
            ForEach(Period.allCases, id: \.self) { p in
                Text(p.displayName).tag(p)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: Summary cards

    private var summaryRow: some View {
        HStack(spacing: 10) {
            summaryCard(
                label: String(localized: "TOKENS"),
                value: formattedTokens(totalTokens),
                icon: "sparkles"
            )
            summaryCard(
                label: String(localized: "SESSIONS"),
                value: "\(totalSessions)",
                icon: "bubble.left.and.bubble.right"
            )
            summaryCard(
                label: String(localized: "SKILLS"),
                value: "\(totalSkills)",
                icon: "hammer"
            )
        }
    }

    private func summaryCard(label: String, value: String, icon: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .monospaced))
                .foregroundStyle(Color.amux.onyx)
                .monospacedDigit()
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(Color.amux.slate)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.amux.paper)
        )
    }

    // MARK: Token ranking

    private var rankingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionEyebrow(String(localized: "TOKEN RANKING"))

            VStack(spacing: 0) {
                ForEach(Array(actorStats.enumerated()), id: \.element.id) { idx, stat in
                    rankRow(rank: idx + 1, stat: stat)
                    if idx < actorStats.count - 1 {
                        Divider()
                            .overlay(Color.amux.hairline)
                            .padding(.leading, 44)
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.amux.paper)
            )
        }
    }

    private func rankRow(rank: Int, stat: ActorStat) -> some View {
        HStack(spacing: 10) {
            // Rank number
            Text("\(rank)")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(rank == 1 ? Color.amux.cinnabar : Color.amux.slate)
                .frame(width: 18, alignment: .center)

            // Avatar dot
            actorDot(stat: stat)

            // Name
            Text(stat.name)
                .font(.subheadline)
                .foregroundStyle(Color.amux.onyx)
                .lineLimit(1)

            Spacer(minLength: 8)

            // Token count
            Text(formattedTokens(stat.tokens))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(rank == 1 ? Color.amux.cinnabar : Color.amux.basalt)
                .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(rank == 1 ? Color.amux.cinnabar.opacity(0.04) : Color.clear)
    }

    private func actorDot(stat: ActorStat) -> some View {
        ZStack {
            if stat.isAgent {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.amux.pebble)
                    .frame(width: 26, height: 26)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Color.amux.hairline, lineWidth: 0.5)
                    )
            } else {
                Circle()
                    .fill(agentColor(for: stat))
                    .frame(width: 26, height: 26)
            }
            Text(initials(stat.name))
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(stat.isAgent ? agentGlyphColor(for: stat) : Color.white)
        }
    }

    // MARK: Skills breakdown

    private var skillsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionEyebrow(String(localized: "SKILLS USAGE"))

            VStack(spacing: 0) {
                ForEach(Array(topSkills.enumerated()), id: \.element.id) { idx, skill in
                    skillRow(skill: skill)
                    if idx < topSkills.count - 1 {
                        Divider()
                            .overlay(Color.amux.hairline)
                            .padding(.leading, 14)
                    }
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.amux.paper)
            )
        }
    }

    private func skillRow(skill: SkillStat) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(skill.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.amux.onyx)
                Spacer()
                Text("\(skill.count)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt)
                    .monospacedDigit()
            }
            GeometryReader { proxy in
                let ratio = maxSkillCount > 0
                    ? CGFloat(skill.count) / CGFloat(maxSkillCount)
                    : 0
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.amux.pebble)
                    Capsule()
                        .fill(LinearGradient(
                            colors: [Color.amux.pebble, Color.amux.cinnabar],
                            startPoint: .leading,
                            endPoint: .trailing
                        ))
                        .frame(width: proxy.size.width * ratio)
                }
            }
            .frame(height: 4)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: Helpers

    private func sectionEyebrow(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.35)
            .foregroundStyle(Color.amux.basalt.opacity(0.7))
    }

    /// Shared with the member stat row — see `formattedTokenCount`.
    private func formattedTokens(_ n: Int) -> String { formattedTokenCount(n) }

    private func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: { $0.isWhitespace }).prefix(2)
        let result = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
        return result.isEmpty ? String(name.prefix(1)).uppercased() : result
    }

    private func agentColor(for stat: ActorStat) -> Color {
        let palette: [Color] = [Color.amux.basalt, Color.amux.slate, Color.amux.sage, Color.amux.onyx]
        let h = abs(stat.id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
        return palette[h % palette.count]
    }

    private func agentGlyphColor(for stat: ActorStat) -> Color {
        switch stat.agentType {
        case "claude", "claude_code": return Color.amux.cinnabar
        case "opencode":              return Color.amux.sage
        case "codex":                 return Color.amux.basalt
        default:                      return Color.amux.basalt
        }
    }
}

#endif
