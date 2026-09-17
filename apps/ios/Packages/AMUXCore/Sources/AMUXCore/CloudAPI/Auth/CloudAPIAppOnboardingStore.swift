import Foundation

/// `AppOnboardingStore` implemented entirely over the TeamClu Cloud API (FC),
/// replacing the Supabase-SDK-backed `SupabaseAppOnboardingStore`.
///
/// Token lifecycle (Keychain persistence, proactive/reactive refresh, the
/// `tokenRefreshes()` stream MQTT depends on) is delegated to `SessionStore`.
/// The unauthenticated GoTrue-proxy auth endpoints are hit via `AuthHTTP`; the
/// authenticated business endpoints (`/v1/teams`,
/// `/v1/invites/claim`) go through `CloudAPIClient`, whose bearer is supplied
/// by `SessionStore.accessToken()`.
public actor CloudAPIAppOnboardingStore: AppOnboardingStore {
    private let sessionStore: SessionStore
    private let auth: AuthHTTP
    private let api: CloudAPIClient
    private let pkce: PKCEStore

    // Captcha token sent with phone send-code. The server's captcha verification
    // is currently a pass-through stub (mirrors the partner SaaS); it only requires a
    // non-empty value. TODO: integrate the Aliyun captcha SDK and pass a real
    // verify token here.
    private static let captchaPlaceholder = "ios-captcha-pending"

    private var didStart = false

    public init(
        configuration: CloudAPIConfiguration,
        storage: SessionStorage,
        send: @escaping CloudAPISend = CloudAPIClient.urlSessionSend
    ) {
        let sessionStore = SessionStore(baseURL: configuration.baseURL, storage: storage, send: send)
        self.sessionStore = sessionStore
        self.auth = AuthHTTP(baseURL: configuration.baseURL, send: send)
        self.api = CloudAPIClient(
            configuration: configuration,
            accessToken: { try await sessionStore.accessToken() },
            send: send
        )
        self.pkce = PKCEStore()
    }

    /// Bridge-only handle to the underlying `SessionStore`. Used exclusively by
    /// `SupabaseSessionBridge` at app composition to seed the Cloud API session
    /// from an existing legacy Supabase session before first use. Not part of
    /// the `AppOnboardingStore` protocol; do not use for normal token access
    /// (go through `accessToken()` instead).
    public nonisolated var sessionStoreForBridge: SessionStore { sessionStore }

    /// Hydrate the session from storage exactly once, before any operation.
    /// Done lazily (rather than a fire-and-forget `Task` in `init`) so the
    /// first call deterministically observes any persisted session.
    private func ensureStarted() async {
        guard !didStart else { return }
        didStart = true
        await sessionStore.start()
    }

    // MARK: - Session presence

    public func ensureSession() async throws {
        await ensureStarted()
        // Both authenticated and anonymous sessions are valid; only the
        // absence of a session counts as "needs auth".
        guard await sessionStore.currentSession() != nil else {
            throw AuthRequired.notAuthenticated
        }
    }

    public func isAnonymous() async -> Bool {
        await ensureStarted()
        return await sessionStore.currentSession()?.isAnonymous ?? false
    }

    public func currentUserEmail() async -> String? {
        await ensureStarted()
        return await sessionStore.currentSession()?.email
    }

    public func accessToken() async throws -> String {
        await ensureStarted()
        return try await sessionStore.accessToken()
    }

    public nonisolated func tokenRefreshes() -> AsyncStream<Void> {
        sessionStore.tokenRefreshes()
    }

    public nonisolated func sessionRevocations() -> AsyncStream<Void> {
        sessionStore.sessionRevocations()
    }

    // MARK: - Sign-in / sign-up

    public func signIn(email: String, password: String) async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/signin-password",
            body: PasswordCredentials(email: email, password: password)
        )
        try await store(g)
    }

    public func signUp(email: String, password: String) async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/signup",
            body: PasswordCredentials(email: email, password: password)
        )
        // FC forwards the raw GoTrue 200 body. Two cases lack a session and
        // must surface as explicit outcomes (otherwise the coordinator falls
        // through to bootstrap → .needsAuth with no error):
        //   • emailAlreadyInUse: anti-enumeration; user has empty identities.
        //   • emailConfirmationRequired: real new user pending confirmation.
        guard g.accessToken == nil else {
            try await store(g)
            return
        }
        let identities = g.user?.identities ?? []
        throw identities.isEmpty
            ? SignUpOutcome.emailAlreadyInUse
            : SignUpOutcome.emailConfirmationRequired
    }

    public func sendEmailOTP(email: String) async throws {
        await ensureStarted()
        // Mirror the Supabase store: create the user if needed. GoTrue decides
        // link-vs-code from the Auth email template ({{ .Token }} → 6-digit).
        try await auth.postVoid(
            "/v1/auth/signin-otp",
            body: OTPRequest(email: email, options: .init(shouldCreateUser: true))
        )
    }

    public func verifyOTP(email: String, token: String) async throws {
        await ensureStarted()
        // The Supabase store tried `.email` then fell back to `.signup`.
        // Replicate by retrying with type "signup" on first failure.
        do {
            let g: GoTrueSession = try await auth.post(
                "/v1/auth/verify-otp",
                body: VerifyOTPRequest(email: email, token: token, type: "email")
            )
            try await store(g)
        } catch {
            let g: GoTrueSession = try await auth.post(
                "/v1/auth/verify-otp",
                body: VerifyOTPRequest(email: email, token: token, type: "signup")
            )
            try await store(g)
        }
    }

    /// partner-aligned: phone login no longer uses GoTrue native OTP (which created
    /// phone-native users divergent from the partner SaaS). We send our own SMS code via
    /// `/v1/auth/phone/send-code` and resolve/create the partner user via
    /// `/v1/auth/phone/login`. See
    /// docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md.
    public func sendPhoneOTP(phone: String) async throws {
        await ensureStarted()
        try await auth.postVoid(
            "/v1/auth/phone/send-code",
            body: PhoneSendCodeRequest(phone: phone, captchaVerify: Self.captchaPlaceholder)
        )
    }

    /// `token` here is the 6-digit SMS code. Protocol conformance: throws on
    /// failure. For multi-user handling call `verifyPhoneOTPResult` instead.
    public func verifyPhoneOTP(phone: String, token: String) async throws {
        _ = try await verifyPhoneOTPResult(phone: phone, token: token)
    }

    /// Returns a `PhoneLoginResult` so callers can distinguish a single sign-in
    /// from the multi-account case without throwing.
    public func verifyPhoneOTPResult(phone: String, token: String) async throws -> PhoneLoginResult {
        await ensureStarted()
        let res: PhoneLoginResponse = try await auth.post(
            "/v1/auth/phone/login",
            body: PhoneLoginRequest(phone: phone, code: token, userId: nil)
        )
        if res.multiUser == true {
            return .multiUser(res.users ?? [])
        }
        guard let session = res.session else {
            throw AuthRequired.notAuthenticated
        }
        try await store(session)
        return .session
    }

    /// Select a specific user when a phone number maps to multiple accounts.
    /// POSTs to `/v1/auth/phone/login` with `userId` to get a single session.
    public func loginWithPhoneUser(phone: String, token: String, userId: String) async throws {
        await ensureStarted()
        let res: PhoneLoginResponse = try await auth.post(
            "/v1/auth/phone/login",
            body: PhoneLoginRequest(phone: phone, code: token, userId: userId)
        )
        guard let session = res.session else {
            throw AuthRequired.notAuthenticated
        }
        try await store(session)
    }

    public func signInWithAppleCredential(idToken: String, nonce: String) async throws {
        await ensureStarted()
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/signin-idtoken",
            body: IdTokenRequest(provider: "apple", idToken: idToken, nonce: nonce)
        )
        try await store(g)
    }

    /// Establish a session from a `refresh_token` (e.g. one returned by an
    /// agent / member-reinvite claim). Hits the camelCase `/v1/auth/refresh`.
    public func setSession(refreshToken: String) async throws {
        await ensureStarted()
        let res: RefreshResponse = try await auth.post(
            "/v1/auth/refresh",
            body: RefreshRequest(refreshToken: refreshToken)
        )
        await sessionStore.setSession(
            StoredSession(
                accessToken: res.accessToken,
                refreshToken: res.refreshToken,
                expiresAt: Date(timeIntervalSince1970: TimeInterval(res.expiresAt)),
                isAnonymous: false,
                email: nil
            )
        )
    }

    public func signOut() async throws {
        await ensureStarted()
        // Best-effort GoTrue logout with the current bearer, then clear local
        // state regardless of the network outcome.
        if let token = try? await sessionStore.accessToken() {
            try? await auth.postVoid("/v1/auth/signout", body: EmptyBody(), bearer: token)
        }
        await sessionStore.clear()
    }

    // MARK: - Google OAuth (PKCE)

    /// The web/SFAuthenticationSession flow (Task 9) drives the browser. The
    /// protocol requires `signInWithGoogle()`, but with the Cloud API the URL
    /// must be opened by the UI layer; there is nothing for the store to do
    /// synchronously. The real work happens in `oauthAuthorizeURL` (which the
    /// UI opens) and `handleAuthCallback` (invoked on the redirect).
    public func signInWithGoogle() async throws {
        await ensureStarted()
    }

    /// Build the authorize URL for the Google OAuth flow, stashing a fresh
    /// PKCE verifier for the subsequent `handleAuthCallback` exchange.
    public func oauthAuthorizeURL(redirect: String = "teamclu://auth-callback") async -> URL? {
        let challenge = await pkce.makeChallenge()
        let base = api.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var components = URLComponents(string: "\(base)/v1/auth/oauth/google/authorize")
        components?.queryItems = [
            URLQueryItem(name: "redirect", value: redirect),
            URLQueryItem(name: "code_challenge", value: challenge),
        ]
        return components?.url
    }

    public func handleAuthCallback(url: URL) async throws {
        await ensureStarted()
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            throw AuthRequired.notAuthenticated
        }
        guard let verifier = await pkce.takeVerifier() else {
            throw AuthRequired.notAuthenticated
        }
        let g: GoTrueSession = try await auth.post(
            "/v1/auth/oauth/exchange",
            body: PKCEExchangeRequest(code: code, codeVerifier: verifier)
        )
        try await store(g)
    }

    // MARK: - Business data

    public func loadBootstrap() async throws -> AppBootstrap {
        await ensureStarted()
        let page: CloudListPage<CloudMembershipTeam> = try await api.get("/v1/teams?scope=all")
        return AppBootstrap(
            memberActorID: nil,
            teams: page.items.filter { $0.isMember != false }.map {
                TeamSummary(
                    id: $0.id,
                    name: $0.name,
                    slug: $0.slug ?? "",
                    role: $0.role ?? "member",
                    orgID: $0.orgId
                )
            },
            memberActorIDByTeam: [:]
        )
    }

    public func listAllMyTeams() async throws -> [MembershipTeam] {
        await ensureStarted()
        let page: CloudListPage<CloudMembershipTeam> = try await api.get("/v1/teams?scope=all")
        return page.items.map {
            MembershipTeam(id: $0.id, name: $0.name, slug: $0.slug ?? "", orgID: $0.orgId, orgName: $0.orgName)
        }
    }

    public func listPendingInvites() async throws -> [PendingInvite] {
        await ensureStarted()
        let page: CloudListPage<CloudPendingInvite> = try await api.get("/v1/invites/pending")
        return page.items.map {
            PendingInvite(
                id: $0.inviteId,
                teamID: $0.teamId,
                teamName: $0.teamName,
                teamRole: $0.teamRole,
                invitedByDisplayName: $0.invitedByDisplayName
            )
        }
    }

    public func acceptPendingInvite(inviteID: String) async throws -> ClaimResult {
        await ensureStarted()
        let encoded = inviteID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? inviteID
        let row: CloudClaimInviteResult = try await api.post(
            "/v1/invites/\(encoded)/accept", body: EmptyBody()
        )
        return ClaimResult(
            actorID: row.actorId,
            teamID: row.teamId,
            actorType: row.actorType,
            displayName: row.displayName,
            refreshToken: row.refreshToken
        )
    }

    public func declinePendingInvite(inviteID: String) async throws {
        await ensureStarted()
        let encoded = inviteID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? inviteID
        try await api.postVoid("/v1/invites/\(encoded)/decline", body: EmptyBody())
    }

    public func switchActiveTeam(teamID: String) async throws -> TeamSwitchResult {
        await ensureStarted()
        let row: CloudSwitchTeamResult = try await api.post(
            "/v1/teams/\(teamID)/activate", body: EmptyBody()
        )
        return TeamSwitchResult(actorID: row.actorId, teamID: row.teamId, refreshToken: row.refreshToken)
    }

    public func createTeam(named name: String) async throws -> CreatedTeam {
        await ensureStarted()
        // POST /v1/teams returns only the team row (id/name/slug). The member
        // create-team endpoint does not echo the member actor (unlike the
        // Supabase `create_team` RPC). Workspace id/name are not surfaced by
        // the Cloud API. Activation is the canonical source for the actor scoped to the
        // newly created team, and also refreshes the session into its org.
        let team: CloudTeam = try await api.post("/v1/teams", body: CreateTeamRequest(name: name))
        let result = try await switchActiveTeam(teamID: team.id)
        try await setSession(refreshToken: result.refreshToken)
        return CreatedTeam(
            team: TeamSummary(id: team.id, name: team.name, slug: team.slug ?? "", role: "owner"),
            memberActorID: result.actorID ?? "",
            workspaceID: "",
            workspaceName: ""
        )
    }

    public func bootstrapTeam() async throws -> CreatedTeam {
        await ensureStarted()
        // Same shape as createTeam: the endpoint returns only the team row, so
        // activation remains the source of the team-scoped actor id (and moves
        // the session into the team's org).
        let team: CloudTeam = try await api.post(
            "/v1/teams/bootstrap", body: BootstrapTeamRequest()
        )
        let result = try await switchActiveTeam(teamID: team.id)
        try await setSession(refreshToken: result.refreshToken)
        return CreatedTeam(
            team: TeamSummary(id: team.id, name: team.name, slug: team.slug ?? "", role: "owner"),
            memberActorID: result.actorID ?? "",
            workspaceID: "",
            workspaceName: ""
        )
    }

    public func claimInvite(token: String) async throws -> ClaimResult {
        await ensureStarted()
        // The claim endpoint works UNAUTHENTICATED for agent/member re-invites
        // (the server returns a refresh token for the target user). Route it
        // through AuthHTTP and attach the current bearer only when a session
        // exists — fresh-member invites bind to auth.uid — but never REQUIRE
        // one. Going through the authenticated `api` client instead would throw
        // locally whenever there's no session (e.g. claimInviteSmart calls
        // signOut() first to "try unauthenticated"), so the re-invite claim
        // never reached the server and always fell back to the anon-then-claim
        // path, which strands the user on a throwaway anonymous identity.
        let bearer = try? await sessionStore.accessToken()
        let row: CloudClaimInviteResult = try await auth.post(
            "/v1/invites/claim",
            body: ClaimInviteRequest(token: token),
            bearer: bearer
        )
        return ClaimResult(
            actorID: row.actorId,
            teamID: row.teamId,
            actorType: row.actorType,
            displayName: row.displayName,
            refreshToken: row.refreshToken
        )
    }

    // MARK: - Private

    /// Commit a GoTrue session body into the SessionStore. Requires both
    /// tokens; otherwise the body did not represent an authenticated session.
    private func store(_ g: GoTrueSession) async throws {
        guard let accessToken = g.accessToken, let refreshToken = g.refreshToken else {
            throw AuthRequired.notAuthenticated
        }
        let expiresAt: Date
        if let epoch = g.expiresAt {
            expiresAt = Date(timeIntervalSince1970: TimeInterval(epoch))
        } else if let expiresIn = g.expiresIn {
            expiresAt = Date().addingTimeInterval(TimeInterval(expiresIn))
        } else {
            // Default to a conservative 1h horizon; SessionStore will refresh
            // proactively before this.
            expiresAt = Date().addingTimeInterval(3600)
        }
        await sessionStore.setSession(
            StoredSession(
                accessToken: accessToken,
                refreshToken: refreshToken,
                expiresAt: expiresAt,
                isAnonymous: g.user?.isAnonymous ?? false,
                email: g.user?.email
            )
        )
    }
}

// MARK: - GoTrue DTOs (raw snake_case body returned by the FC auth proxy)

private struct GoTrueSession: Decodable, Sendable {
    let accessToken: String?
    let refreshToken: String?
    let expiresAt: Int?
    let expiresIn: Int?
    let user: GoTrueUser?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresAt = "expires_at"
        case expiresIn = "expires_in"
        case user
    }
}

private struct GoTrueUser: Decodable, Sendable {
    let email: String?
    let isAnonymous: Bool?
    let identities: [GoTrueIdentity]?

    enum CodingKeys: String, CodingKey {
        case email
        case isAnonymous = "is_anonymous"
        case identities
    }
}

private struct GoTrueIdentity: Decodable, Sendable {}

// MARK: - Request bodies

private struct PasswordCredentials: Encodable, Sendable {
    let email: String
    let password: String
}

private struct EmailUpdate: Encodable, Sendable {
    let email: String
}

private struct OTPRequest: Encodable, Sendable {
    let email: String
    let options: Options
    struct Options: Encodable, Sendable {
        let shouldCreateUser: Bool
    }
}

private struct VerifyOTPRequest: Encodable, Sendable {
    let email: String
    let token: String
    let type: String
}


// ── partner-aligned phone login (send-code / login) ────────────────────────────

private struct PhoneSendCodeRequest: Encodable, Sendable {
    let phone: String
    let captchaVerify: String
}

private struct PhoneLoginRequest: Encodable, Sendable {
    let phone: String
    let code: String
    let userId: String?
    enum CodingKeys: String, CodingKey {
        case phone, code
        case userId = "user_id"
    }
}

/// `/v1/auth/phone/login` response: either a session (resolved/created user) or
/// `multiUser` when the phone maps to multiple accounts (picker — later slice).
private struct PhoneLoginResponse: Decodable, Sendable {
    let session: GoTrueSession?
    let multiUser: Bool?
    let users: [PhoneUser]?
}

/// A user account returned when a phone number maps to multiple accounts.
/// The caller shows a picker so the user can choose which account to sign in to.
public struct PhoneUser: Decodable, Sendable, Identifiable {
    public let id: String
    public let orgId: String?
    public let orgName: String?
    public let orgLogo: String?
    public let nickname: String
    public let email: String

    enum CodingKeys: String, CodingKey {
        case id
        case orgId = "org_id"
        case orgName = "org_name"
        case orgLogo = "org_logo"
        case nickname
        case email
    }
}

/// Result of `verifyPhoneOTP`: either a session was established, or multiple
/// accounts are tied to the phone and the user must choose.
public enum PhoneLoginResult: Sendable {
    case session
    case multiUser([PhoneUser])
}

/// Errors surfaced by the partner-aligned phone login.

private struct IdTokenRequest: Encodable, Sendable {
    let provider: String
    let idToken: String
    let nonce: String
}

private struct RefreshRequest: Encodable, Sendable {
    let refreshToken: String
}

private struct RefreshResult: Decodable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Int
}

// partner-aligned phone identity upgrade (bind to current account, NOT phone_change).
private struct BindPhoneRequest: Encodable, Sendable {
    let phone: String
    let code: String
}

private struct BindPhoneResponse: Decodable, Sendable {
    let userId: String?
    let bound: Bool?
}

// org→team login picker DTOs.
private struct CloudListPage<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
}

private struct CloudMembershipTeam: Decodable, Sendable {
    let id: String
    let name: String
    let slug: String?
    let orgId: String?
    let orgName: String?
    let role: String?
    let isMember: Bool?
}

private struct CloudPendingInvite: Decodable, Sendable {
    let inviteId: String
    let teamId: String
    let teamName: String?
    let teamRole: String?
    let invitedByDisplayName: String?
}

private struct CloudSwitchTeamResult: Decodable, Sendable {
    let actorId: String?
    let teamId: String
    let refreshToken: String
}



private struct RefreshResponse: Decodable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Int
}

private struct PKCEExchangeRequest: Encodable, Sendable {
    let code: String
    let codeVerifier: String
}

private struct CreateTeamRequest: Encodable, Sendable {
    let name: String
}

/// The endpoint takes no input any more — the server resolves the org and its
/// default team from the caller's identity alone. Kept as an explicit empty
/// body so the POST still sends `{}` rather than nothing.
private struct BootstrapTeamRequest: Encodable, Sendable {}

private struct ClaimInviteRequest: Encodable, Sendable {
    let token: String
}

// MARK: - Business response DTOs

private struct CloudTeam: Decodable, Sendable {
    let id: String
    let name: String
    let slug: String?
}

private struct CloudClaimInviteResult: Decodable, Sendable {
    let actorId: String
    let teamId: String
    let actorType: String
    let displayName: String
    let refreshToken: String?
}
