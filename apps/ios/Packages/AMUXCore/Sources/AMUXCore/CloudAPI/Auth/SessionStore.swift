import Foundation

/// Owns the access/refresh token lifecycle that the Supabase SDK previously
/// managed: Keychain persistence, proactive + reactive refresh, and the
/// `tokenRefreshes()` stream that MQTT depends on.
public actor SessionStore {
    private let baseURL: URL
    private let storage: SessionStorage
    private let http: AuthHTTP

    private var session: StoredSession?
    private var refreshTask: Task<Void, Never>?
    private var continuations: [UUID: AsyncStream<Void>.Continuation] = [:]
    private var revocationContinuations: [UUID: AsyncStream<Void>.Continuation] = [:]

    /// Refresh this many seconds before the JWT `exp` to absorb clock skew.
    private let refreshLeadSeconds: TimeInterval = 60

    public init(baseURL: URL, storage: SessionStorage, send: @escaping CloudAPISend = CloudAPIClient.urlSessionSend) {
        self.baseURL = baseURL
        self.storage = storage
        self.http = AuthHTTP(baseURL: baseURL, send: send)
    }

    public func start() {
        session = (try? storage.load()) ?? nil
        scheduleProactiveRefresh()
    }

    public func setSession(_ new: StoredSession) {
        session = new
        try? storage.save(new)
        scheduleProactiveRefresh()
    }

    public func currentSession() -> StoredSession? { session }

    public func clear() {
        session = nil
        try? storage.clear()
        refreshTask?.cancel()
        refreshTask = nil
    }

    public func accessToken() async throws -> String {
        guard let s = session else { throw AuthRequired.notAuthenticated }
        if Self.effectiveExpiry(of: s).timeIntervalSinceNow <= refreshLeadSeconds {
            return try await refreshLocked().accessToken
        }
        return s.accessToken
    }

    /// When the stored `expiresAt` and the access token's own `exp` disagree, the
    /// token wins: a server that reports its refresh-credential lifetime here
    /// (FC's Better-Auth backend did — ~7d session expiry for a ~15m JWT) would
    /// otherwise park us on a dead token, and every Cloud API read 401s with
    /// "Invalid or expired access token" until the session lapses. Taking the
    /// earlier of the two also recovers sessions already persisted with a bad
    /// expiry, since their `exp` is in the past.
    static func effectiveExpiry(of session: StoredSession) -> Date {
        guard let claimed = jwtExpiry(session.accessToken) else { return session.expiresAt }
        return min(claimed, session.expiresAt)
    }

    /// `exp` of a JWT, read without verifying the signature — this only reads the
    /// lifetime the issuer advertised, it is not an authorization decision.
    static func jwtExpiry(_ token: String) -> Date? {
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        var payload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = json["exp"] as? NSNumber else { return nil }
        return Date(timeIntervalSince1970: exp.doubleValue)
    }

    /// `sub` of a JWT — the authenticated user's id — read without verifying
    /// the signature. Like `jwtExpiry` this is not an authorization decision:
    /// it only names the topic to subscribe to, and the broker's own ACL
    /// decides whether that subscription is allowed.
    ///
    /// FC publishes the inbox ping to `inbox/<auth user id>`, which is a
    /// different UUID from the member actor id this app otherwise works in.
    static func jwtSubject(_ token: String) -> String? {
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        var payload = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sub = json["sub"] as? String,
              !sub.isEmpty else { return nil }
        return sub
    }

    /// The authenticated user's id for the session currently held, if any.
    public func currentUserID() -> String? {
        session.flatMap { Self.jwtSubject($0.accessToken) }
    }

    public func forceRefresh() async throws {
        _ = try await refreshLocked()
    }

    public nonisolated func tokenRefreshes() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let id = UUID()
            Task { await self.register(id: id, continuation: continuation) }
            continuation.onTermination = { _ in Task { await self.unregister(id: id) } }
        }
    }

    private func register(id: UUID, continuation: AsyncStream<Void>.Continuation) {
        continuations[id] = continuation
    }

    private func unregister(id: UUID) {
        continuations[id] = nil
    }

    private func emitRefresh() {
        for c in continuations.values { c.yield() }
    }

    /// Emits when the server refuses the refresh token and the session is
    /// dropped — it was ended somewhere else. Every later call throws
    /// `AuthRequired`, so the app has to go back to sign-in rather than keep
    /// showing screens that can no longer load.
    public nonisolated func sessionRevocations() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let id = UUID()
            Task { await self.registerRevocation(id: id, continuation: continuation) }
            continuation.onTermination = { _ in Task { await self.unregisterRevocation(id: id) } }
        }
    }

    private func registerRevocation(id: UUID, continuation: AsyncStream<Void>.Continuation) {
        revocationContinuations[id] = continuation
    }

    private func unregisterRevocation(id: UUID) {
        revocationContinuations[id] = nil
    }

    private func emitRevocation() {
        for c in revocationContinuations.values { c.yield() }
    }

    private func refreshLocked() async throws -> StoredSession {
        guard let s = session else { throw AuthRequired.notAuthenticated }
        struct Req: Encodable { let refreshToken: String }
        struct Res: Decodable { let accessToken: String; let refreshToken: String; let expiresAt: Int }
        do {
            let res: Res = try await http.post("/v1/auth/refresh", body: Req(refreshToken: s.refreshToken))
            let updated = StoredSession(
                accessToken: res.accessToken, refreshToken: res.refreshToken,
                expiresAt: Date(timeIntervalSince1970: TimeInterval(res.expiresAt)),
                isAnonymous: s.isAnonymous, email: s.email
            )
            session = updated
            try? storage.save(updated)
            scheduleProactiveRefresh()
            emitRefresh()
            return updated
        } catch let apiError as CloudAPIError {
            if case let .requestFailed(status, _, _) = apiError, (400..<500).contains(status) {
                // Token is invalid/expired — clear session to force re-login.
                clear()
                emitRevocation()
                throw AuthRequired.notAuthenticated
            }
            // Network or server error — keep the session alive so the next
            // launch can retry instead of forcing a full re-login.
            throw apiError
        } catch {
            // URLError, decoding failure, etc. — preserve the session.
            throw error
        }
    }

    private func scheduleProactiveRefresh() {
        refreshTask?.cancel()
        guard let s = session else { return }
        let delay = max(0, Self.effectiveExpiry(of: s).timeIntervalSinceNow - refreshLeadSeconds)
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            try? await self?.forceRefresh()
        }
    }
}
