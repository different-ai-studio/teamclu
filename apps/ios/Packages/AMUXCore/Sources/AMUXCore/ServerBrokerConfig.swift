import Foundation
import Observation

/// A resolved MQTT broker address: what `MQTTService.connect` needs.
public struct MQTTEndpoint: Equatable, Sendable, Codable {
    public var host: String
    public var port: Int
    public var useTLS: Bool

    public init(host: String, port: Int, useTLS: Bool) {
        self.host = host
        self.port = port
        self.useTLS = useTLS
    }

    /// Parse a broker address from the Cloud API. Accepts a scheme-qualified URL
    /// (`mqtts://host:8883`, `mqtt://host:1883`, `wss://host/mqtt`) or a bare
    /// `host:port`. `defaultUseTLS` decides TLS only when the string carries no
    /// scheme to decide it.
    public static func parse(_ raw: String, defaultUseTLS: Bool = false) -> MQTTEndpoint? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var rest = trimmed
        var useTLS = defaultUseTLS
        var sawScheme = false
        if let separator = trimmed.range(of: "://") {
            let scheme = trimmed[trimmed.startIndex..<separator.lowerBound].lowercased()
            rest = String(trimmed[separator.upperBound...])
            sawScheme = true
            switch scheme {
            case "mqtts", "ssl", "tls", "wss", "https": useTLS = true
            case "mqtt", "tcp", "ws", "http": useTLS = false
            default: return nil
            }
        }

        // Drop any path/query (`wss://host/mqtt`) — CocoaMQTT dials host:port.
        if let slash = rest.firstIndex(of: "/") { rest = String(rest[rest.startIndex..<slash]) }
        guard !rest.isEmpty else { return nil }

        let parts = rest.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let host = String(parts[0])
        guard !host.isEmpty else { return nil }

        if parts.count > 1, let port = Int(parts[1]), port > 0, port <= 65535 {
            return MQTTEndpoint(host: host, port: port, useTLS: useTLS)
        }
        // No explicit port. A scheme-qualified URL implies the standard MQTT
        // port for its transport; a bare host falls back to the bundled default.
        let port = sawScheme ? (useTLS ? 8883 : 1883) : SharedDefaults.services.mqttPort
        return MQTTEndpoint(host: host, port: port, useTLS: useTLS)
    }
}

/// `GET /v1/config/bootstrap` response (the subset iOS consumes). The broker
/// address is env-driven server-side, which is why it is fetched rather than
/// bundled — a moved broker must not require an App Store release.
struct BootstrapConfigResponse: Decodable, Sendable {
    struct MQTTBlock: Decodable, Sendable {
        let url: String?
        let tcpUrl: String?
        let useTls: Bool?
    }

    struct FeaturesBlock: Decodable, Sendable {
        let apps: Bool?
    }

    let mqtt: MQTTBlock?
    let features: FeaturesBlock?
}

/// Post-sign-in feature flags from `GET /v1/config/bootstrap` (`features`).
///
/// The sibling of `PublicAuthFlags`, which carries the pre-sign-in ones. Same
/// rule about absence: FC omits the whole block when the deployment configures
/// no feature profile, and that means "keep the client's defaults", not "turn
/// everything off". Within a present block a missing key IS off — that is the
/// deployment's explicit choice, the way copilot361 ships `apps: false`.
///
/// UI gating only. The server authorizes every one of these calls regardless.
public struct BootstrapFeatureFlags: Equatable, Sendable {
    /// The team-apps surface: the drawer entry and the pages behind it.
    public var apps: Bool

    public init(apps: Bool) {
        self.apps = apps
    }

    /// What the client assumes before the server answers, and when it never
    /// does. Apps is on for every deployment that configures a profile except
    /// copilot361, so failing open matches the common case; a reachable server
    /// that says otherwise corrects it within one launch.
    public static let failOpen = BootstrapFeatureFlags(apps: true)
}

/// Last broker address handed out by the Cloud API, kept on disk so a cold
/// launch (or an offline one) can connect before `/v1/config/bootstrap` answers.
public protocol BrokerConfigCache: AnyObject, Sendable {
    func save(_ endpoint: MQTTEndpoint)
    func load() -> MQTTEndpoint?
    func clear()
}

// @unchecked Sendable is safe: UserDefaults is documented as thread-safe.
public final class UserDefaultsBrokerConfigCache: BrokerConfigCache, @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func save(_ endpoint: MQTTEndpoint) {
        defaults.set(endpoint.host, forKey: Keys.host)
        defaults.set(endpoint.port, forKey: Keys.port)
        defaults.set(endpoint.useTLS, forKey: Keys.useTLS)
    }

    public func load() -> MQTTEndpoint? {
        guard let host = defaults.string(forKey: Keys.host), !host.isEmpty else { return nil }
        let port = defaults.object(forKey: Keys.port) != nil
            ? defaults.integer(forKey: Keys.port)
            : SharedDefaults.services.mqttPort
        return MQTTEndpoint(
            host: host,
            port: port > 0 ? port : SharedDefaults.services.mqttPort,
            useTLS: defaults.bool(forKey: Keys.useTLS)
        )
    }

    public func clear() {
        for key in Keys.all { defaults.removeObject(forKey: key) }
    }

    private enum Keys {
        static let host = "teamclu_server_broker_host"
        static let port = "teamclu_server_broker_port"
        static let useTLS = "teamclu_server_broker_use_tls"
        static let all = [host, port, useTLS]
    }
}

public enum ServerBrokerConfig {
    /// Fetch the broker address from the Cloud API. Returns nil when the server
    /// ships no MQTT block (broker not configured for that deployment).
    ///
    /// `tcpUrl` wins over `url`: CocoaMQTT speaks raw MQTT, while `url` may be
    /// the WebSocket address meant for browser clients.
    public static func fetch(client: CloudAPIClient) async throws -> MQTTEndpoint? {
        try await fetchBootstrap(client: client).broker
    }

    /// Both halves of the bootstrap answer in one round trip. The broker
    /// address and the feature flags arrive together, and the caller already
    /// makes this request on every launch — asking twice would be a second
    /// request for a document it already holds.
    public static func fetchBootstrap(
        client: CloudAPIClient
    ) async throws -> (broker: MQTTEndpoint?, features: BootstrapFeatureFlags?) {
        let config: BootstrapConfigResponse = try await client.get("/v1/config/bootstrap")
        var broker: MQTTEndpoint?
        if let mqtt = config.mqtt, let raw = mqtt.tcpUrl ?? mqtt.url {
            broker = MQTTEndpoint.parse(raw, defaultUseTLS: mqtt.useTls ?? false)
        }
        // nil when the block is absent entirely — see BootstrapFeatureFlags.
        let features = config.features.map { BootstrapFeatureFlags(apps: $0.apps ?? false) }
        return (broker, features)
    }
}

/// Holds the last feature flags the server sent, for views to read.
///
/// `@MainActor` and `@Observable` so a SwiftUI surface appears or disappears
/// when the answer arrives, without every view fetching for itself.
@MainActor
@Observable
public final class FeatureFlagsStore {
    public private(set) var flags: BootstrapFeatureFlags = .failOpen

    public init(flags: BootstrapFeatureFlags = .failOpen) {
        self.flags = flags
    }

    /// A nil answer leaves the current flags alone: it means the server sent
    /// no block, or could not be reached, and neither is a decision to turn
    /// anything off.
    public func apply(_ incoming: BootstrapFeatureFlags?) {
        guard let incoming else { return }
        flags = incoming
    }
}
