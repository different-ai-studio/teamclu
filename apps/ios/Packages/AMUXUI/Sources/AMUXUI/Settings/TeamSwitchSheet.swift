import SwiftUI
import AMUXSharedUI
import AMUXCore

/// Settings → Switch Team. A Hai sheet over Settings listing every team the
/// user belongs to, grouped by org, with the current one marked. Picking
/// another team hands it to `onPick`; the caller dismisses Settings and runs
/// the switch, which rebuilds the shell underneath.
struct TeamSwitchSheet: View {
    @Environment(\.dismiss) private var dismiss

    let coordinator: AppOnboardingCoordinator
    let currentTeamID: String?
    let onPick: (_ teamID: String, _ choices: [MembershipTeam]) -> Void

    @State private var teams: [MembershipTeam] = []
    @State private var isLoading = true
    @State private var loadError: String?

    /// Teams grouped by org name, preserving first-seen order — same grouping
    /// as the login-time `OrgTeamPickerView`.
    private var groups: [(org: String, teams: [MembershipTeam])] {
        var order: [String] = []
        var byOrg: [String: [MembershipTeam]] = [:]
        for team in teams {
            let key = team.orgName ?? String(localized: "Other")
            if byOrg[key] == nil { order.append(key) }
            byOrg[key, default: []].append(team)
        }
        return order.map { ($0, byOrg[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.amux.mist.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        content
                    }
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Switch Team")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(Color.amux.basalt)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("teamSwitch.closeButton")
                }
            }
            .task { await load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
        } else if let loadError {
            VStack(alignment: .leading, spacing: 10) {
                Text(loadError)
                    .font(.footnote)
                    .foregroundStyle(Color.amux.cinnabarDeep)
                Button("Retry") { Task { await load() } }
                    .font(.system(size: 14, weight: .semibold))
                    .tint(Color.amux.cinnabar)
            }
            .padding(.horizontal, 24)
        } else {
            ForEach(groups, id: \.org) { group in
                VStack(alignment: .leading, spacing: 8) {
                    HaiSectionLabel(group.org)
                    HaiPaperCard {
                        ForEach(Array(group.teams.enumerated()), id: \.element.id) { idx, team in
                            teamRow(team)
                            if idx != group.teams.count - 1 {
                                Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
                                    .padding(.leading, 14)
                            }
                        }
                    }
                }
            }
        }
    }

    private func teamRow(_ team: MembershipTeam) -> some View {
        let isCurrent = team.id == currentTeamID
        return Button {
            guard !isCurrent else { return }
            onPick(team.id, teams)
        } label: {
            HStack(spacing: 10) {
                Text(team.name)
                    .font(.system(size: 15, weight: isCurrent ? .semibold : .regular))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if isCurrent {
                    Text("Current")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.amux.basalt.opacity(0.75))
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.amux.cinnabar)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .accessibilityIdentifier("teamSwitch.row.\(team.id)")
    }

    private func load() async {
        isLoading = true
        loadError = nil
        do {
            teams = try await coordinator.loadSwitchableTeams()
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }
}
