import XCTest
@testable import AMUXCore

/// Callers outside onboarding (push, quick reply, attachments) used to read
/// the Keychain and fail on a lapsed token. They now share one refreshing
/// `SessionStore`.
final class CloudAccessTokenTests: XCTestCase {
    override func tearDown() {
        CloudAccessToken.register(nil)
        super.tearDown()
    }

    func testProviderRefreshesALapsedTokenThroughTheSharedStore() async throws {
        let storage = InMemorySessionStorage()
        try storage.save(StoredSession(accessToken: "stale", refreshToken: "rt",
            expiresAt: Date().addingTimeInterval(-60), isAnonymous: false, email: nil))
        let refreshes = LockedBox<Int>(); refreshes.set(0)
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage, send: { req in
            refreshes.set((refreshes.get() ?? 0) + 1)
            let json = #"{"accessToken":"fresh","refreshToken":"rt2","expiresAt":9000000000}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (json.data(using: .utf8)!, resp)
        })
        CloudAccessToken.register(store)

        let provider = CloudAccessToken.provider(configuration: {
            CloudAPIConfiguration(baseURL: URL(string: "https://c")!)
        })
        let token = try await provider()

        XCTAssertEqual(token, "fresh")
        XCTAssertEqual(refreshes.get(), 1)
        XCTAssertEqual(try storage.load()?.refreshToken, "rt2")
    }

    func testSessionStoreIsReusedPerServerAndReplacedOnAMove() {
        let a = CloudAPIConfiguration(baseURL: URL(string: "https://a")!)
        let b = CloudAPIConfiguration(baseURL: URL(string: "https://b")!)
        let first = CloudAccessToken.sessionStore(for: a, storage: InMemorySessionStorage())
        let again = CloudAccessToken.sessionStore(for: a, storage: InMemorySessionStorage())
        let moved = CloudAccessToken.sessionStore(for: b, storage: InMemorySessionStorage())

        XCTAssertTrue(first === again)
        XCTAssertFalse(first === moved)
        XCTAssertTrue(CloudAccessToken.sessionStore(for: b, storage: InMemorySessionStorage()) === moved)
    }

    func testProviderWithoutAConfiguredServerThrows() async {
        let provider = CloudAccessToken.provider(configuration: { nil })
        do {
            _ = try await provider()
            XCTFail("expected missingAccessToken")
        } catch {
            guard case .missingAccessToken? = error as? CloudAPIError else {
                return XCTFail("unexpected error \(error)")
            }
        }
    }
}
