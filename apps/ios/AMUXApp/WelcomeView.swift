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
    let eyebrow: LocalizedStringKey
    let title: LocalizedStringKey
    let body: LocalizedStringKey
}

/// The three cards spell the product line: 协作 → 共享 → 创造
/// (work together, keep the know-how, turn workflows into apps).
private struct IntroView: View {
    let onFinish: () -> Void
    @State private var page = 0

    private let cards: [IntroCard] = [
        IntroCard(id: 0, eyebrow: "COLLABORATE",
                  title: "Get it done with your AI partners",
                  body: "Teammates and AI partners share one conversation — talk it through, split the work, ship it. You make the call; they do the legwork."),
        IntroCard(id: 1, eyebrow: "SHARE",
                  title: "Your team's know-how, kept for everyone",
                  body: "Knowledge, skills, keys and memory live with the team — every new member and every AI partner can use them from day one."),
        IntroCard(id: 2, eyebrow: "CREATE",
                  title: "Turn repeat work into your own apps",
                  body: "Run a workflow once, and your AI partner can build it into an app. Next time just open it — and so can the whole team."),
    ]

    private var isLastPage: Bool { page == cards.count - 1 }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(BrandInfo.appName)
                    .font(.amuxSerif(22, weight: .regular))
                    .foregroundStyle(Color.amux.onyx)

                if !isLastPage {
                    Button("Skip", action: onFinish)
                        .font(.subheadline)
                        .foregroundStyle(Color.amux.slate)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.horizontal, 24)
                        .accessibilityIdentifier("welcome.skipButton")
                }
            }
            .padding(.top, 24)

            TabView(selection: $page) {
                ForEach(cards) { card in
                    IntroCardView(card: card).tag(card.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            pageDots
                .padding(.bottom, 24)

            // Two identities so UI tests can tell "advance" from "finish";
            // `welcome.getStartedButton` only exists on the last card.
            Button {
                if isLastPage {
                    onFinish()
                } else {
                    withAnimation(.easeOut(duration: 0.25)) { page += 1 }
                }
            } label: {
                Text(isLastPage ? "Get Started" : "Continue")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .glassProminentButtonStyle()
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
            .accessibilityIdentifier(isLastPage ? "welcome.getStartedButton" : "welcome.continueButton")
        }
        .animation(.easeOut(duration: 0.2), value: isLastPage)
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
            illustration
                .frame(maxWidth: .infinity)
                .frame(height: 260)
                .accessibilityHidden(true)
                .padding(.bottom, 36)

            (Text(String(format: "%02d·", card.id + 1)) + Text(card.eyebrow))
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

    @ViewBuilder
    private var illustration: some View {
        switch card.id {
        case 0: SharedSessionIllustration()
        case 1: TeamKnowledgeIllustration()
        default: WorkflowToAppIllustration()
        }
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
