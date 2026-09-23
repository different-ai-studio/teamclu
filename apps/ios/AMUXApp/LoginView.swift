import SwiftUI
import AuthenticationServices
import AMUXSharedUI
import AMUXCore

struct LoginView: View {
    @Bindable var coordinator: AppOnboardingCoordinator
    @State private var email = ""
    @State private var password = ""
    @State private var phone = "+86"
    @State private var code = ""
    @State private var loginMethod: LoginMethod = .email
    /// Remote gating for the optional sign-in methods (`features.auth` from
    /// `GET /v1/config/public`). Starts fail-open so a slow network never
    /// strips buttons; the server's answer replaces it as soon as it lands.
    @State private var authFlags: PublicAuthFlags = .failOpen

    private enum LoginMethod: Hashable { case email, password, phone }

    /// True once either an email or phone code has been requested.
    private var isCodeStep: Bool {
        coordinator.pendingEmailOTPEmail != nil || coordinator.pendingPhoneOTPPhone != nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header

                if isCodeStep {
                    codeEntrySection
                } else {
                    methodPicker
                    if loginMethod == .email {
                        emailEntrySection
                    } else if loginMethod == .password {
                        passwordEntrySection
                    } else {
                        phoneEntrySection
                    }
                }

                if let err = coordinator.errorMessage {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                divider

                socialButtons
            }
            .padding(.horizontal, 24)
            .padding(.top, 72)
            .padding(.bottom, 36)
        }
        .background(Color.amux.mist)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let base = CloudAPIConfigurationStore.configuration()?.baseURL else { return }
            if let flags = await PublicAuthFlags.fetch(baseURL: base) {
                authFlags = flags
                // If the current selection just got gated off, land on the
                // base method instead of a blank pane.
                if (loginMethod == .password && !flags.password)
                    || (loginMethod == .phone && !flags.phone) {
                    loginMethod = .email
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { !coordinator.phoneMultipleUsers.isEmpty },
            set: { if !$0 { coordinator.phoneMultipleUsers = [] } }
        )) {
            phoneAccountPickerSheet
        }
    }

    // MARK: - Multi-account picker sheet

    @ViewBuilder
    private var phoneAccountPickerSheet: some View {
        NavigationStack {
            List(coordinator.phoneMultipleUsers) { user in
                Button {
                    coordinator.phoneMultipleUsers = []
                    Task { await coordinator.selectPhoneUser(user) }
                } label: {
                    HStack(spacing: 12) {
                        orgLogoView(for: user)
                        VStack(alignment: .leading, spacing: 4) {
                            if let orgName = user.orgName, !orgName.isEmpty {
                                Text(orgName)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.amux.basalt)
                            }
                            Text(user.nickname.isEmpty ? user.email : user.nickname)
                                .font(.body.weight(.medium))
                                .foregroundStyle(Color.amux.onyx)
                            if !user.nickname.isEmpty && !user.email.isEmpty {
                                Text(user.email)
                                    .font(.footnote)
                                    .foregroundStyle(Color.amux.basalt)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Choose account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        coordinator.phoneMultipleUsers = []
                    }
                }
            }
        }
    }

    /// Org logo for a picker row: shows the org's logo image when available,
    /// otherwise a neutral placeholder with the org/nickname initial.
    @ViewBuilder
    private func orgLogoView(for user: PhoneUser) -> some View {
        let size: CGFloat = 40
        let corner: CGFloat = 10
        if let logo = user.orgLogo, let url = URL(string: logo), !logo.isEmpty {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                default:
                    orgLogoPlaceholder(for: user)
                }
            }
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        } else {
            orgLogoPlaceholder(for: user)
                .frame(width: size, height: size)
        }
    }

    @ViewBuilder
    private func orgLogoPlaceholder(for user: PhoneUser) -> some View {
        let initialSource = (user.orgName?.isEmpty == false ? user.orgName : nil)
            ?? (user.nickname.isEmpty ? user.email : user.nickname)
        let initial = initialSource.first.map(String.init)?.uppercased() ?? "?"
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color.amux.pebble)
            .overlay(
                Text(initial)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.amux.basalt)
            )
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(isCodeStep ? "Enter the code" : "Sign in")
                .font(.amuxSerif(38, weight: .regular))
                .foregroundStyle(Color.amux.onyx)
            Text(headerSubtitle)
                .font(.body)
                .foregroundStyle(Color.amux.basalt)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headerSubtitle: LocalizedStringKey {
        if coordinator.pendingPhoneOTPPhone != nil {
            return "Check your messages for a 6-digit code."
        }
        if coordinator.pendingEmailOTPEmail != nil {
            return "Check your inbox for a 6-digit code."
        }
        return loginMethod == .phone
            ? "We'll text you a 6-digit code."
            : loginMethod == .password
                ? "Use your email and password to sign in."
                : "We'll email you a 6-digit code."
    }

    // MARK: - Method picker

    @ViewBuilder
    private var methodPicker: some View {
        // Email OTP is the base method; password/phone appear only when the
        // deployment enables them. A single-method deployment needs no picker.
        if authFlags.password || authFlags.phone {
            Picker("Sign-in method", selection: $loginMethod) {
                Text("Email").tag(LoginMethod.email)
                if authFlags.password {
                    Text("Password").tag(LoginMethod.password)
                }
                if authFlags.phone {
                    Text("Phone").tag(LoginMethod.phone)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("login.methodPicker")
        }
    }

    // MARK: - Phone entry (step 1)

    private var phoneEntrySection: some View {
        VStack(spacing: 12) {
            authField {
                TextField("Phone number", text: $phone)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .accessibilityIdentifier("login.phoneField")
            }

            primaryButton(title: "Send code", enabled: phone.count > 4) {
                Task { await coordinator.sendPhoneOTP(phone: phone) }
            }
        }
    }

    // MARK: - Email entry (step 1)

    private var emailEntrySection: some View {
        VStack(spacing: 12) {
            authField {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("login.emailField")
            }

            primaryButton(title: "Send code", enabled: !email.isEmpty) {
                Task { await coordinator.sendEmailOTP(email: email) }
            }
        }
    }

    // MARK: - Email/password entry

    private var passwordEntrySection: some View {
        VStack(spacing: 12) {
            authField {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .autocapitalization(.none)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("login.emailField")
            }

            authField {
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .accessibilityIdentifier("login.passwordField")
            }

            primaryButton(title: "Sign in", enabled: !email.isEmpty && !password.isEmpty) {
                Task { await coordinator.signIn(email: email, password: password) }
            }
        }
    }

    // MARK: - Code entry (step 2)

    private var codeEntrySection: some View {
        VStack(spacing: 12) {
            if let destination = coordinator.pendingPhoneOTPPhone ?? coordinator.pendingEmailOTPEmail {
                Text("Code sent to **\(destination)**")
                    .font(.footnote)
                    .foregroundStyle(Color.amux.basalt)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            authField {
                TextField("6-digit code", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .accessibilityIdentifier("login.codeField")
                    .onChange(of: code) { _, newValue in
                        let digits = newValue.filter { $0.isNumber }
                        code = String(digits.prefix(6))
                    }
            }

            primaryButton(title: "Verify", enabled: code.count == 6) {
                if let pendingPhone = coordinator.pendingPhoneOTPPhone {
                    Task { await coordinator.verifyPhoneOTP(phone: pendingPhone, token: code) }
                } else if let pendingEmail = coordinator.pendingEmailOTPEmail {
                    Task { await coordinator.verifyOTP(email: pendingEmail, token: code) }
                }
            }

            Button {
                code = ""
                if coordinator.pendingPhoneOTPPhone != nil {
                    coordinator.resetPendingPhoneOTP()
                } else {
                    coordinator.resetPendingEmailOTP()
                }
            } label: {
                Text(coordinator.pendingPhoneOTPPhone != nil ? "Use a different number" : "Use a different email")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.amux.cinnabarDeep)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Shared widgets

    private func primaryButton(title: LocalizedStringKey, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if coordinator.isBusy {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(enabled ? Color.white : Color.amux.slate)
                }
                Text(title)
                    .font(.body.weight(.semibold))
            }
            .foregroundStyle(enabled ? Color.white : Color.amux.slate)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(enabled ? Color.amux.cinnabar : Color.amux.pebble.opacity(0.82))
                    .shadow(color: enabled ? Color.amux.onyx.opacity(0.10) : .clear,
                            radius: 18, x: 0, y: 10)
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled || coordinator.isBusy)
        .accessibilityIdentifier("login.submitButton")
    }

    private var divider: some View {
        HStack(spacing: 14) {
            Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
            Text("or")
                .font(.footnote)
                .foregroundStyle(Color.amux.slate)
            Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
        }
    }

    private var socialButtons: some View {
        VStack(spacing: 10) {
            socialButton(title: "Sign in with Apple", icon: "applelogo") {
                Analytics.track("sign_in_started", ["method": "apple"])
                Task { await coordinator.signInWithApple() }
            }

            if authFlags.google {
                socialButton(title: "Sign in with Google", icon: "globe") {
                    Analytics.track("sign_in_started", ["method": "google"])
                    Task { await signInWithGoogleOAuth() }
                }
            }
        }
    }

    private func authField<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .font(.body)
            .foregroundStyle(Color.amux.onyx)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.amux.paper)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 1)
            )
    }

    // MARK: - Google OAuth via ASWebAuthenticationSession

    @MainActor
    private func signInWithGoogleOAuth() async {
        guard !coordinator.isBusy else { return }
        guard let authorizeURL = await coordinator.oauthAuthorizeURL() else {
            // Store does not support PKCE OAuth (e.g. Supabase fallback); no-op.
            return
        }

        // Mark busy while the browser session is open.
        coordinator.isBusy = true
        coordinator.errorMessage = nil

        let callbackURL: URL
        do {
            callbackURL = try await withCheckedThrowingContinuation { continuation in
                let session = ASWebAuthenticationSession(
                    url: authorizeURL,
                    callbackURLScheme: "teamclu"
                ) { url, error in
                    if let error = error as? ASWebAuthenticationSessionError,
                       error.code == .canceledLogin {
                        // User cancelled — treat as silent no-op.
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    if let url {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: ASWebAuthenticationSessionError(
                            .presentationContextNotProvided))
                    }
                }
                session.presentationContextProvider = WebAuthContextProvider.shared
                session.prefersEphemeralWebBrowserSession = true
                session.start()
            }
        } catch is CancellationError {
            coordinator.isBusy = false
            return
        } catch {
            coordinator.isBusy = false
            coordinator.errorMessage = error.localizedDescription
            return
        }

        // Release our isBusy lock before delegating to handleAuthCallback,
        // which guards against re-entry itself and manages isBusy internally.
        coordinator.isBusy = false
        await coordinator.handleAuthCallback(url: callbackURL)
    }

    private func socialButton(title: LocalizedStringKey, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 19, weight: .medium))
                    .frame(width: 24)
                Text(title)
                    .font(.body.weight(.semibold))
            }
            .foregroundStyle(Color.amux.onyx)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.amux.paper.opacity(0.82))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(coordinator.isBusy)
    }
}

// MARK: - ASWebAuthentication presentation context

/// Provides the key window as the presentation anchor for
/// `ASWebAuthenticationSession`. A single shared instance is sufficient
/// because the session is always presented from the app's active window.
private final class WebAuthContextProvider: NSObject,
    ASWebAuthenticationPresentationContextProviding, @unchecked Sendable {

    static let shared = WebAuthContextProvider()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Walk the connected scenes to find the first key window.
        let windowScene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first
        return windowScene?.keyWindow ?? ASPresentationAnchor()
    }
}
