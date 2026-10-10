import Foundation

/// Classifies pasted / opened invite and join-link URLs.
public enum InviteURL {
    private static let appSchemes: Set<String> = ["teamclu", "teamclaw", "amux"]

    /// `teamclu://invite?token=…` (also `teamclaw` / `amux`) or a bare token.
    /// Host `join` is never an invite.
    public static func parseInviteToken(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed),
           let scheme = url.scheme,
           appSchemes.contains(scheme),
           url.host == "invite",
           let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let token = comps.queryItems?.first(where: { $0.name == "token" })?.value,
           !token.isEmpty {
            return token
        }
        if !trimmed.contains("://") {
            return trimmed
        }
        return nil
    }

    /// `https://host/join/<token>` (exactly one path segment after `join`;
    /// `cloudAPIURL` is the origin) or `teamclu` / `teamclaw` / `amux` with
    /// host `join` and a `token` query.
    public static func parseJoinLink(_ raw: String) -> (token: String, cloudAPIURL: URL?)? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme
        else { return nil }

        if scheme == "https" || scheme == "http" {
            let parts = url.pathComponents.filter { $0 != "/" }
            guard parts.count == 2, parts[0] == "join", !parts[1].isEmpty else { return nil }
            var origin = URLComponents()
            origin.scheme = scheme
            origin.host = url.host
            origin.port = url.port
            let token = parts[1].removingPercentEncoding ?? parts[1]
            return (token, origin.url)
        }

        guard appSchemes.contains(scheme),
              url.host == "join",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = comps.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty
        else { return nil }

        let cloudAPIURL: URL?
        if let rawCloud = comps.queryItems?.first(where: { $0.name == "cloud_api_url" })?.value,
           !rawCloud.isEmpty {
            cloudAPIURL = URL(string: rawCloud)
        } else {
            cloudAPIURL = nil
        }
        return (token, cloudAPIURL)
    }
}
