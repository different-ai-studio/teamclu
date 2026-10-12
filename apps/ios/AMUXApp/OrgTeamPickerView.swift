import SwiftUI
import AMUXCore

/// Shown at login when the user belongs to more than one team (across orgs) and
/// has no remembered choice. Two-level: teams grouped by org. Picking one calls
/// `coordinator.selectTeam`, which switches the active team (fresh session for
/// that org) and lands the app. See
/// docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md §6.
struct OrgTeamPickerView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var busyTeamID: String?

    /// Teams grouped by org name, preserving first-seen order. Teams without an
    /// org name fall into a single "Other" bucket.
    private var groups: [(org: String, teams: [MembershipTeam])] {
        var order: [String] = []
        var byOrg: [String: [MembershipTeam]] = [:]
        for team in coordinator.teamChoices {
            let key = team.orgName ?? "Other"
            if byOrg[key] == nil { order.append(key) }
            byOrg[key, default: []].append(team)
        }
        return order.map { ($0, byOrg[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let err = coordinator.errorMessage {
                    Section {
                        Text(err).font(.footnote).foregroundStyle(.red)
                    }
                }
                ForEach(groups, id: \.org) { group in
                    Section(group.org) {
                        ForEach(group.teams) { team in
                            Button {
                                pick(team.id)
                            } label: {
                                HStack {
                                    Text(team.name)
                                    Spacer()
                                    if busyTeamID == team.id {
                                        ProgressView()
                                    } else {
                                        Image(systemName: "chevron.right")
                                            .font(.footnote)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                            .disabled(busyTeamID != nil)
                        }
                    }
                }
            }
            .navigationTitle("Choose a team")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Only the Settings-initiated switch can go back: at login
                // there is no previous team context to return to.
                if coordinator.currentContext != nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            coordinator.cancelTeamSwitch()
                        }
                        .disabled(busyTeamID != nil)
                        .accessibilityIdentifier("teamPicker.cancelButton")
                    }
                }
            }
        }
    }

    private func pick(_ teamID: String) {
        guard busyTeamID == nil else { return }
        busyTeamID = teamID
        Task {
            await coordinator.selectTeam(teamID: teamID)
            busyTeamID = nil
        }
    }
}

/// Shown after an email / Apple / Google sign-in when the person has identities
/// in more than one org — their later identities sit on accounts nobody signs
/// in to directly. Picking one swaps the session to that identity
/// (`coordinator.chooseIdentity`); the team picker that follows lists that
/// org's teams. See docs/plans/2026-10-08-staff-only-identity-model.md.
struct IdentityPickerView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var busyUserID: String?

    var body: some View {
        NavigationStack {
            List {
                if let err = coordinator.errorMessage {
                    Section {
                        Text(err).font(.footnote).foregroundStyle(.red)
                    }
                }
                Section {
                    ForEach(coordinator.identityChoices) { identity in
                        Button {
                            pick(identity)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(identity.orgName ?? String(localized: "Unnamed organization"))
                                    if let role = roleLabel(identity.adminType) {
                                        Text(role).font(.footnote).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if busyUserID == identity.userID {
                                    ProgressView()
                                } else if identity.isCurrent {
                                    Text("Current account").font(.footnote).foregroundStyle(.secondary)
                                } else {
                                    Image(systemName: "chevron.right")
                                        .font(.footnote)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .disabled(busyUserID != nil)
                        .accessibilityIdentifier("identityPicker.row.\(identity.userID)")
                    }
                } footer: {
                    Text("You belong to more than one organization. Pick the one to enter this time.")
                }
            }
            .navigationTitle("Choose an organization")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func roleLabel(_ adminType: Int) -> String? {
        if adminType >= 3 { return String(localized: "Super admin") }
        if adminType == 2 { return String(localized: "Admin") }
        return nil
    }

    private func pick(_ identity: MyIdentity) {
        guard busyUserID == nil else { return }
        busyUserID = identity.userID
        Task {
            await coordinator.chooseIdentity(identity)
            busyUserID = nil
        }
    }
}
