import Foundation

/// Fetches a message attachment's bytes by its `bucket_path`.
///
/// Everything a message carries is addressed by path, not by URL — see
/// `MessageAttachment`. `GET /v1/attachments/:path` is caller-scoped, so the
/// fetch has to go through `CloudAPIClient` with the user's bearer; an
/// `AsyncImage` pointed at that route gets a 401, and iOS is never told the
/// storage origin, so there is no public URL to fall back to.
///
/// Results land in a temp file and are reused: a thumbnail, a fullscreen
/// viewer and a QuickLook preview of the same attachment then cost one
/// download between them.
public actor AttachmentContentLoader {
    public static let shared = AttachmentContentLoader()

    private var cached: [String: URL] = [:]
    private var inFlight: [String: Task<URL, Error>] = [:]

    public init() {}

    /// The attachment as a file on disk, downloading it the first time.
    ///
    /// `fileName` is preserved on the local copy because QuickLook picks its
    /// renderer from the path extension — a PDF saved without one previews as
    /// an unrecognised blob.
    public func localURL(bucketPath: String, fileName: String) async throws -> URL {
        if let hit = cached[bucketPath], FileManager.default.fileExists(atPath: hit.path) {
            return hit
        }
        if let running = inFlight[bucketPath] {
            return try await running.value
        }
        let task = Task<URL, Error> { [bucketPath, fileName] in
            try await Self.download(bucketPath: bucketPath, fileName: fileName)
        }
        inFlight[bucketPath] = task
        defer { inFlight[bucketPath] = nil }
        let url = try await task.value
        cached[bucketPath] = url
        return url
    }

    /// The attachment's bytes, from the on-disk copy.
    public func data(bucketPath: String, fileName: String) async throws -> Data {
        let url = try await localURL(bucketPath: bucketPath, fileName: fileName)
        return try Data(contentsOf: url)
    }

    private static func download(bucketPath: String, fileName: String) async throws -> URL {
        guard let config = CloudAPIConfigurationStore.configuration() else {
            throw CloudAPIError.invalidResponse
        }
        let storage = KeychainSessionStorage()
        let client = CloudAPIClient(configuration: config, accessToken: {
            guard let session = try storage.load(), session.expiresAt.timeIntervalSinceNow > 0 else {
                throw CloudAPIError.missingAccessToken
            }
            return session.accessToken
        })
        // The whole path is one route parameter, so every separator in it has
        // to survive as an escape — `urlPathAllowed` keeps `/` and the route
        // would then read only the first segment.
        let encoded = bucketPath.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? bucketPath
        let (bytes, _) = try await client.getRawBytes("/v1/attachments/\(encoded)")

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("attachment-cache", isDirectory: true)
            .appendingPathComponent(safeComponent(bucketPath), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(safeComponent(fileName))
        try bytes.write(to: destination, options: .atomic)
        return destination
    }

    /// A single path component, whatever the producer called the file. A name
    /// carrying `/` or `..` would otherwise write outside the directory made
    /// for it.
    private static func safeComponent(_ raw: String) -> String {
        let cleaned = raw
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "..", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "attachment" : cleaned
    }
}
