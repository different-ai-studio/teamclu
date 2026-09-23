import SwiftUI
import AMUXCore
import AMUXSharedUI

/// `route == .noTeam`: signed in, in no team, and the user said they're
/// joining one — so nothing was auto-created. Most likely the invite hasn't
/// arrived yet or they signed in with a different account than the one
/// invited. Every way out is here.
struct NoTeamView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    let onSignOut: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var showInviteSheet = false
    @State private var showDesktopGuide = false
    @State private var isRefreshing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                        .padding(.top, 40)
                        .padding(.horizontal, 28)

                    if !coordinator.pendingInvites.isEmpty {
                        pendingInvites
                            .padding(.top, 28)
                            .padding(.horizontal, 24)
                    }

                    options
                        .padding(.top, 28)
                        .padding(.horizontal, 24)

                    if let err = coordinator.errorMessage, !err.isEmpty {
                        OnboardingErrorNote(message: err)
                            .padding(.horizontal, 24)
                            .padding(.top, 16)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 32)
            }
            .background(Color.amux.mist)
            .navigationDestination(isPresented: $showDesktopGuide) {
                DesktopGuideView(mode: .signedIn) {
                    trackExit("create")
                    Task { await coordinator.createTeamFromNoTeam() }
                }
            }
            .sheet(isPresented: $showInviteSheet) {
                InviteJoinSheet(coordinator: coordinator, onJoinSignedIn: { token in
                    trackExit("paste_invite")
                    await coordinator.joinWithInvite(token: token)
                })
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
        }
        .onAppear { Analytics.track("onboarding_no_team_shown") }
        .task { await coordinator.refreshPendingInvites() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await refresh() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Not in a team yet")
                .font(.amuxSerif(34, weight: .regular))
                .foregroundStyle(Color.amux.onyx)
            Group {
                if let email = coordinator.currentUserEmail, !email.isEmpty {
                    Text("\(email) isn't in any team yet. Ask your team admin to invite this account, then refresh.")
                } else {
                    Text("This account isn't in any team yet. Ask your team admin to invite it, then refresh.")
                }
            }
            .font(.body)
            .foregroundStyle(Color.amux.basalt)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var pendingInvites: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("INVITES FOR YOU")
                .font(.system(size: 10, design: .monospaced))
                .tracking(2.5)
                .foregroundStyle(Color.amux.slate)

            ForEach(coordinator.pendingInvites) { invite in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(invite.teamName ?? String(localized: "A team"))
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.amux.onyx)
                        if let by = invite.invitedByDisplayName, !by.isEmpty {
                            Text("Invited by \(by)")
                                .font(.caption)
                                .foregroundStyle(Color.amux.basalt)
                        }
                    }
                    Spacer(minLength: 8)
                    Button {
                        trackExit("invite_accepted")
                        Task { _ = await coordinator.acceptPendingInvite(invite) }
                    } label: {
                        Text("Join")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.amux.cinnabar)
                    }
                    .buttonStyle(.plain)
                    .disabled(coordinator.isBusy)
                }
                .padding(16)
                .background(Color.amux.paper)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                )
            }
        }
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 12) {
            OnboardingOptionRow(
                icon: "arrow.clockwise",
                title: isRefreshing ? String(localized: "Checking…") : String(localized: "Refresh"),
                caption: String(localized: "Check again after your admin sends the invite."),
                isPrimary: true
            ) {
                Task { await refresh() }
            }
            .disabled(isRefreshing)
            .accessibilityIdentifier("noTeam.refreshButton")

            OnboardingOptionRow(
                icon: "link",
                title: String(localized: "Paste an invite link"),
                caption: String(localized: "A teammate sent you a link."),
                isPrimary: false
            ) {
                showInviteSheet = true
            }
            .accessibilityIdentifier("noTeam.pasteInviteButton")

            OnboardingOptionRow(
                icon: "person.crop.circle.badge.questionmark",
                title: String(localized: "Use another account"),
                caption: String(localized: "The invite went to a different email or phone."),
                isPrimary: false
            ) {
                trackExit("switch_account")
                onSignOut()
            }
            .accessibilityIdentifier("noTeam.switchAccountButton")

            OnboardingOptionRow(
                icon: "plus.square",
                title: String(localized: "Start a new team instead"),
                caption: String(localized: "Set up \(BrandInfo.appName) for your own team."),
                isPrimary: false
            ) {
                showDesktopGuide = true
            }
            .accessibilityIdentifier("noTeam.createButton")
        }
        .disabled(coordinator.isBusy)
    }

    private func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        await coordinator.refreshNoTeam()
        isRefreshing = false
    }

    private func trackExit(_ exit: String) {
        Analytics.track("onboarding_no_team_exit", ["exit": exit])
    }
}
