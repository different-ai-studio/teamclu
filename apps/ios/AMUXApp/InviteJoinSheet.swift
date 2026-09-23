import SwiftUI
import AMUXCore
import AMUXSharedUI

// MARK: - InviteJoinSheet

/// Lets the user paste a `teamclu://invite?token=…` link (or a bare token)
/// before they have a session. Two paths: "Continue" joins anonymously (then
/// RootTabView replays the token through the usual claim pipeline), or "I
/// already have an account" routes to sign-in with the token stashed so an
/// existing user joins the team under their real identity.
///
/// With `onJoinSignedIn` set (the no-team screen, already signed in) there is
/// one path: claim as the current account. `claimInviteSmart` must not be used
/// there — it signs out first.
struct InviteJoinSheet: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var raw: String = ""
    @State private var localError: String?

    /// Claims the parsed token as the signed-in user. When set, replaces the
    /// signed-out paths below.
    var onJoinSignedIn: ((String) async -> Void)? = nil

    /// Called with the parsed token when the user chooses to sign in to an
    /// existing account instead of joining anonymously.
    var onUseExistingAccount: ((String) -> Void)? = nil

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Join with invite link")
                        .font(.title2.bold())
                    Text(onJoinSignedIn == nil
                         ? "Paste the link your teammate shared. Continue as a guest, or sign in to an account you already have."
                         : "Paste the link your teammate shared to join their team with this account.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                TextField("teamclu://invite?token=… or just the token",
                          text: $raw,
                          axis: .vertical)
                    .lineLimit(2...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.amux.pebble)
                    )
                    .onChange(of: raw) { _, _ in
                        // Clear stale errors as soon as the user edits the
                        // field so a retry doesn't show last attempt's copy.
                        if localError != nil { localError = nil }
                        if coordinator.errorMessage != nil { coordinator.errorMessage = nil }
                    }

                if let inlineError {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.amux.cinnabar)
                        Text(inlineError)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.onyx)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.amux.cinnabar.opacity(0.10))
                    )
                }

                Button {
                    submit()
                } label: {
                    Text(coordinator.isBusy ? "Joining…" : "Continue")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .glassProminentButtonStyle()
                .controlSize(.large)
                .disabled(coordinator.isBusy ||
                          raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if onJoinSignedIn == nil {
                    Button {
                        useExistingAccount()
                    } label: {
                        Text("I already have an account")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.amux.cinnabar)
                    .disabled(coordinator.isBusy ||
                              raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("invite.useExistingAccountButton")
                }

                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var inlineError: String? {
        if let local = localError, !local.isEmpty { return local }
        if let remote = coordinator.errorMessage, !remote.isEmpty { return remote }
        return nil
    }

    private func submit() {
        guard let token = parseToken(raw) else {
            localError = String(localized: "Couldn't read a token from that link.")
            return
        }
        localError = nil
        coordinator.errorMessage = nil
        Task {
            if let onJoinSignedIn {
                await onJoinSignedIn(token)
            } else {
                await coordinator.claimInviteSmart(token: token)
            }
            await MainActor.run {
                // Only dismiss on success — on failure the sheet stays open
                // with the error inline so the user can paste a new token
                // without navigating back through Welcome → ChooseAuth.
                if coordinator.route == .ready {
                    dismiss()
                }
            }
        }
    }

    private func useExistingAccount() {
        guard let token = parseToken(raw) else {
            localError = String(localized: "Couldn't read a token from that link.")
            return
        }
        localError = nil
        coordinator.errorMessage = nil
        dismiss()
        onUseExistingAccount?(token)
    }

    /// Accepts both `teamclu://invite?token=XYZ` and bare `XYZ`. Trims whitespace.
    private func parseToken(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed),
           let scheme = url.scheme,
           ["teamclu", "teamclaw", "amux"].contains(scheme), url.host == "invite",
           let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let token = comps.queryItems?.first(where: { $0.name == "token" })?.value,
           !token.isEmpty {
            return token
        }
        // Treat raw input without a URL scheme as the bare token.
        if !trimmed.contains("://") {
            return trimmed
        }
        return nil
    }
}
