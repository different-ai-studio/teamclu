import XCTest
@testable import AMUXCore

final class SessionStoreTests: XCTestCase {
    private func refreshResponder(at expiresAtEpoch: Int, count: LockedBox<Int>) -> CloudAPISend {
        { req in
            let n = (count.get() ?? 0) + 1; count.set(n)
            let json = #"{"accessToken":"at\#(n)","refreshToken":"rt\#(n)","expiresAt":\#(expiresAtEpoch)}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (json.data(using: .utf8)!, resp)
        }
    }

    func testAccessTokenReturnsCachedWhenValid() async throws {
        let storage = InMemorySessionStorage()
        try storage.save(StoredSession(accessToken: "valid", refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(3600), isAnonymous: false, email: nil))
        let count = LockedBox<Int>(); count.set(0)
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage,
            send: refreshResponder(at: 9_000_000_000, count: count))
        await store.start()
        let token = try await store.accessToken()
        XCTAssertEqual(token, "valid")
        XCTAssertEqual(count.get(), 0)
    }

    func testForceRefreshRotatesTokenAndEmits() async throws {
        let storage = InMemorySessionStorage()
        try storage.save(StoredSession(accessToken: "old", refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(3600), isAnonymous: false, email: nil))
        let count = LockedBox<Int>(); count.set(0)
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage,
            send: refreshResponder(at: 9_000_000_000, count: count))
        await store.start()

        let emitted = expectation(description: "tokenRefreshes emits")
        let stream = store.tokenRefreshes()
        Task { for await _ in stream { emitted.fulfill(); break } }

        try await store.forceRefresh()
        let token = try await store.accessToken()
        XCTAssertEqual(token, "at1")
        await fulfillment(of: [emitted], timeout: 2)
        XCTAssertEqual(try storage.load()?.refreshToken, "rt1")
    }

    /// FC's Better-Auth backend reported the ~7d session expiry as the
    /// access-token expiry, so the store sat on a JWT that had already died and
    /// every Cloud API read failed with "Invalid or expired access token".
    /// The token's own `exp` must win over the server-reported expiry.
    func testAccessTokenRefreshesWhenJWTExpiryPrecedesStoredExpiry() async throws {
        let storage = InMemorySessionStorage()
        let deadJWT = Self.jwt(expiringAt: Date().addingTimeInterval(-60))
        try storage.save(StoredSession(accessToken: deadJWT, refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(7 * 24 * 3600), isAnonymous: false, email: nil))
        let count = LockedBox<Int>(); count.set(0)
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage,
            send: refreshResponder(at: 9_000_000_000, count: count))
        await store.start()

        // The proactive timer fires immediately for an already-expired token, so
        // it may win the race with this call — either way the dead JWT must be
        // replaced rather than handed out.
        let token = try await store.accessToken()
        XCTAssertNotEqual(token, deadJWT)
        XCTAssertTrue(token.hasPrefix("at"), "expected a refreshed token, got \(token)")
        XCTAssertGreaterThanOrEqual(count.get() ?? 0, 1)
    }

    func testJWTExpiryReadsExpClaimAndIgnoresNonJWTs() {
        let expiry = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(
            SessionStore.jwtExpiry(Self.jwt(expiringAt: expiry))?.timeIntervalSince1970,
            expiry.timeIntervalSince1970
        )
        XCTAssertNil(SessionStore.jwtExpiry("opaque-session-token"))
        XCTAssertNil(SessionStore.jwtExpiry("a.b.c"))
    }

    /// Unsigned stand-in for a real access token: only the payload's `exp` is read.
    private static func jwt(expiringAt date: Date) -> String {
        func segment(_ object: [String: Any]) -> String {
            let data = try! JSONSerialization.data(withJSONObject: object)
            return data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let header = segment(["alg": "HS256", "typ": "JWT"])
        let payload = segment(["sub": "user-1", "exp": Int(date.timeIntervalSince1970)])
        return "\(header).\(payload).signature"
    }

    /// The server no longer knows the refresh token — the session was ended
    /// elsewhere (another device signing out used to do this to every device).
    /// The store must drop the session and say so, so the app can go back to
    /// sign-in instead of leaving every screen failing on AuthRequired.
    func testRefreshRejectedByServerClearsSessionAndEmitsRevocation() async throws {
        let storage = InMemorySessionStorage()
        try storage.save(StoredSession(accessToken: "old", refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(3600), isAnonymous: false, email: nil))
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage, send: { req in
            let json = #"{"error":{"code":"refresh_token_not_found","message":"Invalid Refresh Token: Refresh Token Not Found"}}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!
            return (json.data(using: .utf8)!, resp)
        })
        await store.start()

        let revoked = expectation(description: "sessionRevocations emits")
        let stream = store.sessionRevocations()
        Task { for await _ in stream { revoked.fulfill(); break } }
        try await Task.sleep(for: .milliseconds(50))

        do { try await store.forceRefresh(); XCTFail("expected throw") }
        catch AuthRequired.notAuthenticated {}
        catch { XCTFail("wrong error: \(error)") }

        await fulfillment(of: [revoked], timeout: 2)
        let remaining = await store.currentSession()
        XCTAssertNil(remaining)
    }

    func testRefreshNetworkFailureKeepsSessionWithoutRevocation() async throws {
        let storage = InMemorySessionStorage()
        try storage.save(StoredSession(accessToken: "old", refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(3600), isAnonymous: false, email: nil))
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage, send: { _ in
            throw URLError(.notConnectedToInternet)
        })
        await store.start()

        let revoked = expectation(description: "sessionRevocations stays silent")
        revoked.isInverted = true
        let stream = store.sessionRevocations()
        Task { for await _ in stream { revoked.fulfill(); break } }
        try await Task.sleep(for: .milliseconds(50))

        do { try await store.forceRefresh(); XCTFail("expected throw") }
        catch is URLError {}
        catch { XCTFail("wrong error: \(error)") }

        await fulfillment(of: [revoked], timeout: 0.3)
        let remaining = await store.currentSession()
        XCTAssertNotNil(remaining)
    }

    func testAccessTokenWithNoSessionThrowsNotAuthenticated() async {
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: InMemorySessionStorage(),
            send: { _ in (Data(), HTTPURLResponse(url: URL(string: "https://c")!, statusCode: 200, httpVersion: nil, headerFields: nil)!) })
        await store.start()
        do { _ = try await store.accessToken(); XCTFail("expected throw") }
        catch AuthRequired.notAuthenticated {}
        catch { XCTFail("wrong error: \(error)") }
    }
}
