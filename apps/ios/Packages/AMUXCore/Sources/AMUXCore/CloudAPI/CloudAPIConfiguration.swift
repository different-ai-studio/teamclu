import Foundation

public struct CloudAPIConfiguration: Equatable, Sendable {
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }
}

public enum CloudAPIConfigurationStore {
    public static let cloudAPIURLKey = "teamclu_cloud_api_url"

    public static func storedCloudAPIURL(in defaults: UserDefaults = .standard) -> String? {
        let value = defaults.string(forKey: cloudAPIURLKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : SharedDefaults.services.cloudApiUrl
    }

    /// The Cloud API endpoint: a UserDefaults override, else the bundled
    /// `cloudApiUrl`. `nil` when neither resolves to a URL.
    public static func configuration(in defaults: UserDefaults = .standard) -> CloudAPIConfiguration? {
        guard let rawCloudURL = storedCloudAPIURL(in: defaults),
              let cloudURL = URL(string: rawCloudURL) else {
            return nil
        }

        return CloudAPIConfiguration(baseURL: cloudURL)
    }
}
