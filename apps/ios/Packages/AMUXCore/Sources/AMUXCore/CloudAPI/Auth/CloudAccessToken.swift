import Foundation
import Synchronization

/// The process-wide bearer for Cloud API calls made outside the onboarding
/// store: push registration, notification quick replies, attachment upload and
/// download, idea thumbnails, mark-viewed.
///
/// Those call sites used to read the Keychain directly and throw once the
/// access token had lapsed, because they had no way to reach the refreshing
/// `SessionStore` and building a second one would race it — two stores
/// spending the same rotating refresh token, where the loser gets the session
/// revoked. This hands every caller the one `SessionStore` instead, so an
/// expired token is refreshed rather than failing.
public enum CloudAccessToken {
    private static let shared = Mutex<SessionStore?>(nil)

    /// The `SessionStore` for `configuration`'s server. The registered one is
    /// reused when it points at the same server; otherwise (first use, or the
    /// user moved to another server) a Keychain-backed store is built and
    /// registered in its place.
    public static func sessionStore(
        for configuration: CloudAPIConfiguration,
        storage: @autoclosure () -> SessionStorage = KeychainSessionStorage()
    ) -> SessionStore {
        shared.withLock { current in
            if let current, current.baseURL == configuration.baseURL { return current }
            let store = SessionStore(baseURL: configuration.baseURL, storage: storage())
            current = store
            return store
        }
    }

    /// Replaces the registered store. Tests only.
    static func register(_ store: SessionStore?) {
        shared.withLock { $0 = store }
    }

    /// A token closure for `CloudAPIClient`. The server is resolved when the
    /// closure runs, not when it is made, so a client built at launch follows
    /// a later server change.
    public static func provider(
        configuration: @escaping @Sendable () -> CloudAPIConfiguration? = { CloudAPIConfigurationStore.configuration() }
    ) -> @Sendable () async throws -> String {
        {
            guard let configuration = configuration() else { throw CloudAPIError.missingAccessToken }
            let store = sessionStore(for: configuration)
            await store.startIfNeeded()
            return try await store.accessToken()
        }
    }
}
