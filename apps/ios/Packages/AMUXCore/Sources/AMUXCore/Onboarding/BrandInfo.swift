import Foundation

/// The few brand facts the pre-login screens show: the product name and where
/// to get the desktop app. The name comes from the bundle so a rebranded build
/// shows its own; the download URL comes from the server (`desktopDownloadUrl`
/// on `GET /v1/config/public`) so each deployment can point at its own page.
public enum BrandInfo {
    /// Used until the server answers, and when it can't be reached.
    public static let defaultDesktopDownloadURL = URL(string: "https://github.com/different-ai-studio/teamclu/releases")!

    public static var appName: String {
        let info = Bundle.main.infoDictionary
        let name = (info?["CFBundleDisplayName"] as? String) ?? (info?["CFBundleName"] as? String)
        guard let name, !name.isEmpty else { return "TeamClu" }
        return name
    }

    /// nil on transport failure or when the server doesn't send the field
    /// (deployments older than it); callers keep `defaultDesktopDownloadURL`.
    public static func fetchDesktopDownloadURL(baseURL: URL, session: URLSession = .shared) async -> URL? {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/config/public"))
        request.httpMethod = "GET"
        request.timeoutInterval = 8
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200
        else { return nil }
        return desktopDownloadURL(fromPublicConfig: data)
    }

    static func desktopDownloadURL(fromPublicConfig data: Data) -> URL? {
        struct PublicConfig: Decodable { let desktopDownloadUrl: String? }
        guard let raw = (try? JSONDecoder().decode(PublicConfig.self, from: data))?.desktopDownloadUrl,
              let url = URL(string: raw.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              url.host?.isEmpty == false
        else { return nil }
        return url
    }
}
