import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Pre-login fork: is this person joining a team that already uses the app,
/// or starting one? The answer is recorded as `onboardingIntent` and decides
/// what happens after sign-in when the account has no team (see
/// `AppOnboardingCoordinator.bootstrap`). Creating a team routes through the
/// desktop-download guide first — teams run their agents on a computer.
struct OnboardingChoiceView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    var onServerChanged: () -> Void = {}

    @State private var showLogin = false
    @State private var showDesktopGuide = false
    @State private var showInviteSheet = false
    @State private var showServerSettings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text("How are you starting?")
                    .font(.amuxSerif(34, weight: .regular))
                    .foregroundStyle(Color.amux.onyx)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(BrandInfo.appName) works best when your whole team is on it.")
                    .font(.body)
                    .foregroundStyle(Color.amux.basalt)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 40)
            .padding(.horizontal, 28)

            Spacer(minLength: 24)

            VStack(alignment: .leading, spacing: 12) {
                OnboardingOptionRow(
                    icon: "person.2",
                    title: String(localized: "Join my team"),
                    caption: String(localized: "My team already uses \(BrandInfo.appName)."),
                    isPrimary: true
                ) {
                    choose(.join)
                    showLogin = true
                }
                .accessibilityIdentifier("onboarding.joinButton")

                OnboardingOptionRow(
                    icon: "plus.square",
                    title: String(localized: "Start a new team"),
                    caption: String(localized: "Set up \(BrandInfo.appName) for my team."),
                    isPrimary: false
                ) {
                    choose(.create)
                    showDesktopGuide = true
                }
                .accessibilityIdentifier("onboarding.createButton")

                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        showInviteSheet = true
                    } label: {
                        Text("Have an invite link?")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.amux.cinnabar)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("onboarding.inviteLinkButton")

                    Text("No invite yet? Ask your team admin to invite you.")
                        .font(.footnote)
                        .foregroundStyle(Color.amux.slate)
                }
                .padding(.top, 8)
                .padding(.horizontal, 4)
            }
            .padding(.horizontal, 24)
            .disabled(coordinator.isBusy)

            if let err = coordinator.errorMessage, !err.isEmpty {
                OnboardingErrorNote(message: err)
                    .padding(.horizontal, 24)
                    .padding(.top, 16)
            }

            Spacer(minLength: 0)
        }
        .padding(.bottom, 32)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.amux.mist)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showServerSettings = true
                } label: {
                    Image(systemName: "network")
                        .font(.title3)
                        .foregroundStyle(Color.amux.slate)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Server settings")
                .accessibilityIdentifier("welcome.serverSettingsButton")
            }
        }
        .navigationDestination(isPresented: $showLogin) {
            LoginView(coordinator: coordinator)
        }
        .navigationDestination(isPresented: $showDesktopGuide) {
            DesktopGuideView(mode: .beforeSignIn) {
                showLogin = true
            }
        }
        .sheet(isPresented: $showServerSettings) {
            ServerSettingsSheet(onSaved: onServerChanged)
        }
        .sheet(isPresented: $showInviteSheet) {
            InviteJoinSheet(coordinator: coordinator) { token in
                // Sign in first; bootstrap claims the token as that account.
                choose(.join)
                coordinator.pendingInviteToken = token
                showLogin = true
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
    }

    private func choose(_ intent: OnboardingIntent) {
        coordinator.errorMessage = nil
        coordinator.onboardingIntent = intent
        Analytics.track("onboarding_path_chosen", ["path": intent.rawValue])
    }
}

// MARK: - Shared onboarding pieces

struct OnboardingOptionRow: View {
    let icon: String
    let title: String
    let caption: String
    let isPrimary: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(isPrimary ? Color.amux.cinnabar : Color.amux.basalt)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.amux.onyx)
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(Color.amux.basalt)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.amux.slate)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.amux.paper)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct OnboardingErrorNote: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.amux.cinnabar)
            Text(message)
                .font(.footnote)
                .foregroundStyle(Color.amux.onyx)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.amux.pebble)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}
