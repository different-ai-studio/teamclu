import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Signed-out root (`route == .needsAuth`):
///   - first install → the intro cards, then the join/create choice
///   - later (after sign-out, a revoked session) → straight to the choice
///   - holding an invite deep link → straight to sign-in; bootstrap claims it
struct WelcomeView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    /// Called after the user saves a different server address so the app
    /// shell can rebuild the Cloud API stack against it.
    var onServerChanged: () -> Void = {}

    @AppStorage(OnboardingFlags.hasSeenIntroKey) private var hasSeenIntro = false
    /// Written by `AMUXApp.handle(url:)` for `teamclu://invite?token=`, and by
    /// `claimInviteSmart` when a member invite needs sign-in first.
    @AppStorage(InviteDeepLink.pendingTokenDefaultsKey) private var pendingInviteLinkToken = ""

    var body: some View {
        NavigationStack {
            Group {
                if !pendingInviteLinkToken.isEmpty {
                    InvitedLoginView(coordinator: coordinator)
                } else if hasSeenIntro {
                    OnboardingChoiceView(coordinator: coordinator, onServerChanged: onServerChanged)
                } else {
                    IntroView {
                        Analytics.track("onboarding_intro_completed")
                        withAnimation(.easeOut(duration: 0.25)) { hasSeenIntro = true }
                    }
                }
            }
        }
    }
}

enum OnboardingFlags {
    /// Set once the intro has been seen — or once the user has ever reached
    /// the app, so people upgrading from a build without the intro skip it.
    static let hasSeenIntroKey = "teamclu.hasSeenIntro"
}

// MARK: - Intro

private struct IntroCard: Identifiable {
    let id: Int
    let eyebrow: String
    let title: LocalizedStringKey
    let body: LocalizedStringKey
    let placeholder: String
}

private struct IntroView: View {
    let onFinish: () -> Void
    @State private var page = 0

    private let cards: [IntroCard] = [
        IntroCard(id: 0, eyebrow: "01",
                  title: "Work alongside your AI allies",
                  body: "Teammates and AI allies share one conversation — discuss, split the work, ship it.",
                  placeholder: "ILLUSTRATION · SHARED SESSION"),
        IntroCard(id: 1, eyebrow: "02",
                  title: "Team knowledge stays in sync",
                  body: "The docs and know-how your team builds up are there for every member and every agent.",
                  placeholder: "ILLUSTRATION · TEAM KNOWLEDGE"),
        IntroCard(id: 2, eyebrow: "03",
                  title: "Your computer works, your phone follows",
                  body: "Agents do the work on your computer. Follow along and make the call from your phone.",
                  placeholder: "ILLUSTRATION · DESKTOP + PHONE"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Text(BrandInfo.appName)
                .font(.amuxSerif(22, weight: .regular))
                .foregroundStyle(Color.amux.onyx)
                .padding(.top, 24)

            TabView(selection: $page) {
                ForEach(cards) { card in
                    IntroCardView(card: card).tag(card.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            pageDots
                .padding(.bottom, 24)

            Button(action: onFinish) {
                Text("Get Started")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .glassProminentButtonStyle()
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
            .accessibilityIdentifier("welcome.getStartedButton")
        }
        .background(Color.amux.mist)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var pageDots: some View {
        HStack(spacing: 8) {
            ForEach(cards) { card in
                Circle()
                    .fill(card.id == page ? Color.amux.onyx : Color.amux.slate.opacity(0.4))
                    .frame(width: 6, height: 6)
            }
        }
        .animation(.easeOut(duration: 0.2), value: page)
        .accessibilityHidden(true)
    }
}

private struct IntroCardView: View {
    let card: IntroCard

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StripedPlaceholder(caption: card.placeholder)
                .frame(height: 260)
                .padding(.bottom, 36)

            Text(card.eyebrow)
                .font(.system(size: 11, design: .monospaced))
                .tracking(3)
                .foregroundStyle(Color.amux.slate)
                .padding(.bottom, 10)

            Text(card.title)
                .font(.amuxSerif(30, weight: .regular))
                .foregroundStyle(Color.amux.onyx)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 12)

            Text(card.body)
                .font(.body)
                .foregroundStyle(Color.amux.basalt)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 28)
        .padding(.top, 28)
    }
}

/// Stand-in for an illustration that hasn't been drawn yet (DESIGN.md: no
/// hand-drawn SVG — stripes plus a mono caption naming the missing asset).
private struct StripedPlaceholder: View {
    let caption: String

    var body: some View {
        ZStack {
            Canvas { context, size in
                let step: CGFloat = 10
                var path = Path()
                var x: CGFloat = -size.height
                while x < size.width {
                    path.move(to: CGPoint(x: x, y: size.height))
                    path.addLine(to: CGPoint(x: x + size.height, y: 0))
                    x += step
                }
                context.stroke(path, with: .color(Color.amux.hairline), lineWidth: 1)
            }
            Text(caption)
                .font(.system(size: 10, design: .monospaced))
                .tracking(2)
                .foregroundStyle(Color.amux.slate)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.amux.mist)
        }
        .background(Color.amux.pebble.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .accessibilityHidden(true)
    }
}

// MARK: - Invited sign-in

/// Sign-in for someone who opened an invite link. LoginView itself is left
/// untouched; the note rides above it. Records a `join` intent so a claim that
/// fails after sign-in lands on the no-team screen, not a fresh team.
private struct InvitedLoginView: View {
    @Bindable var coordinator: AppOnboardingCoordinator

    var body: some View {
        LoginView(coordinator: coordinator)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(Color.amux.cinnabar)
                        .frame(width: 7, height: 7)
                        .padding(.top, 6)
                    Text("You've got a team invite. Sign in and you'll join the team automatically.")
                        .font(.footnote)
                        .foregroundStyle(Color.amux.onyx)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(Color.amux.pebble)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .accessibilityIdentifier("onboarding.inviteNotice")
            }
            .onAppear { coordinator.onboardingIntent = .join }
    }
}
