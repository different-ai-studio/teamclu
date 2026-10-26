import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

// MARK: - IdeaStatsSheet

/// Team-wide idea statistics. Opened from the leading toolbar button in
/// the ideas list. Mirrors `TeamStatsSheet`: period picker, 3 summary cards,
/// a contributor ranking, and a per-workspace breakdown. All counts are
/// computed from real `IdeaRecord` data (active + archived) filtered by
/// `createdAt` against the selected period.
struct IdeaStatsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let ideas: [IdeaRecord]
    let archivedIdeas: [IdeaRecord]
    let actors: [CachedActor]
    let workspaces: [Workspace]

    enum Period: String, CaseIterable {
        case today = "Today"
        case week  = "Week"
        case month = "Month"
        case all   = "All"

        /// Separate from `rawValue`, which doubles as enum identity.
        var displayName: String {
            switch self {
            case .today: return String(localized: "Today")
            case .week: return String(localized: "Week")
            case .month: return String(localized: "Month")
            case .all: return String(localized: "All")
            }
        }
    }

    @State private var period: Period = .week

    // MARK: Derived data

    private var periodCutoff: Date? {
        let cal = Calendar.current
        switch period {
        case .today: return cal.startOfDay(for: Date())
        case .week:  return cal.date(byAdding: .day, value: -7,  to: Date())
        case .month: return cal.date(byAdding: .day, value: -30, to: Date())
        case .all:   return nil
        }
    }

    /// Active + archived, filtered by period.
    private var scopedIdeas: [IdeaRecord] {
        let all = ideas + archivedIdeas
        guard let cutoff = periodCutoff else { return all }
        return all.filter { $0.createdAt >= cutoff }
    }

    private var totalCount: Int { scopedIdeas.count }
    private var openCount: Int {
        scopedIdeas.filter { $0.status == "open" || $0.status == "in_progress" }.count
    }
    private var doneCount: Int { scopedIdeas.filter { $0.status == "done" }.count }

    private struct ContributorStat: Identifiable {
        let id: String
        let name: String
        let isAgent: Bool
        let isOnline: Bool
        let agentType: String?
        let count: Int
    }

    private var actorById: [String: CachedActor] {
        Dictionary(uniqueKeysWithValues: actors.map { ($0.actorId, $0) })
    }

    private var contributorStats: [ContributorStat] {
        let grouped = Dictionary(grouping: scopedIdeas, by: { $0.createdByActorID })
        return grouped.map { (actorID, group) -> ContributorStat in
            let actor = actorById[actorID]
            return ContributorStat(
                id: actorID,
                name: actor?.displayName ?? "Unknown",
                isAgent: actor?.isAgent ?? false,
                isOnline: actor?.isOnline ?? false,
                agentType: actor?.defaultAgentType,
                count: group.count
            )
        }
        .sorted { $0.count > $1.count }
    }

    private struct WorkspaceStat: Identifiable {
        let id: String
        let name: String
        let count: Int
    }

    private var workspaceNameById: [String: String] {
        Dictionary(uniqueKeysWithValues: workspaces.map { ($0.workspaceId, $0.displayName) })
    }

    private var workspaceStats: [WorkspaceStat] {
        let grouped = Dictionary(grouping: scopedIdeas, by: { $0.workspaceID })
        return grouped.map { (wsID, group) in
            WorkspaceStat(
                id: wsID.isEmpty ? "_unassigned" : wsID,
                name: wsID.isEmpty
                    ? "Unassigned"
                    : (workspaceNameById[wsID] ?? "Workspace"),
                count: group.count
            )
        }
        .sorted { $0.count > $1.count }
    }

    private var maxWorkspaceCount: Int {
        max(1, workspaceStats.map(\.count).max() ?? 1)
    }

    // MARK: Body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    periodPicker
                    summaryRow
                    if contributorStats.isEmpty {
                        emptyState
                    } else {
                        rankingSection
                    }
                    if !workspaceStats.isEmpty {
                        workspacesSection
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .background(Color.amux.mist)
            .navigationTitle("Idea Statistics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Color.amux.onyx)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
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
                label: "TOTAL",
                value: "\(totalCount)",
                icon: "lightbulb"
            )
            summaryCard(
                label: "OPEN",
                value: "\(openCount)",
                icon: "circle"
            )
            summaryCard(
                label: "DONE",
                value: "\(doneCount)",
                icon: "checkmark.circle"
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

    // MARK: Contributor ranking

    private var rankingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionEyebrow("TOP CONTRIBUTORS")

            VStack(spacing: 0) {
                ForEach(Array(contributorStats.enumerated()), id: \.element.id) { idx, stat in
                    rankRow(rank: idx + 1, stat: stat)
                    if idx < contributorStats.count - 1 {
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

    private func rankRow(rank: Int, stat: ContributorStat) -> some View {
        HStack(spacing: 10) {
            Text("\(rank)")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(rank == 1 ? Color.amux.cinnabar : Color.amux.slate)
                .frame(width: 18, alignment: .center)

            actorDot(stat: stat)

            Text(stat.name)
                .font(.subheadline)
                .foregroundStyle(Color.amux.onyx)
                .lineLimit(1)

            Spacer(minLength: 8)

            Text("\(stat.count)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(rank == 1 ? Color.amux.cinnabar : Color.amux.basalt)
                .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(rank == 1 ? Color.amux.cinnabar.opacity(0.04) : Color.clear)
    }

    private func actorDot(stat: ContributorStat) -> some View {
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

    // MARK: Workspaces breakdown

    private var workspacesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionEyebrow("WORKSPACES")

            VStack(spacing: 0) {
                ForEach(Array(workspaceStats.enumerated()), id: \.element.id) { idx, stat in
                    workspaceRow(stat: stat)
                    if idx < workspaceStats.count - 1 {
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

    private func workspaceRow(stat: WorkspaceStat) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(stat.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                Spacer()
                Text("\(stat.count)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt)
                    .monospacedDigit()
            }
            GeometryReader { proxy in
                let ratio = maxWorkspaceCount > 0
                    ? CGFloat(stat.count) / CGFloat(maxWorkspaceCount)
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

    // MARK: Empty state

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("No ideas in this period")
                .font(.subheadline)
                .fontWeight(.medium)
                .foregroundStyle(Color.amux.basalt)
            Text("Try widening the range above")
                .font(.footnote)
                .foregroundStyle(Color.amux.slate)
        }
        .frame(maxWidth: .infinity, minHeight: 120)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.amux.paper)
        )
    }

    // MARK: Helpers

    private func sectionEyebrow(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.35)
            .foregroundStyle(Color.amux.basalt.opacity(0.7))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: { $0.isWhitespace }).prefix(2)
        let result = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
        return result.isEmpty ? String(name.prefix(1)).uppercased() : result
    }

    private func agentColor(for stat: ContributorStat) -> Color {
        let palette: [Color] = [Color.amux.basalt, Color.amux.slate, Color.amux.sage, Color.amux.onyx]
        let h = abs(stat.id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
        return palette[h % palette.count]
    }

    private func agentGlyphColor(for stat: ContributorStat) -> Color {
        switch stat.agentType {
        case "claude", "claude_code": return Color.amux.cinnabar
        case "opencode":              return Color.amux.sage
        case "codex":                 return Color.amux.basalt
        default:                      return Color.amux.basalt
        }
    }
}

#endif
