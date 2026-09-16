import CryptoKit
import Foundation

/// On-disk cache of verified trace blobs, evicted least-recently-used past a
/// byte budget.
///
/// A trace never changes once uploaded (FC answers 409 to a second prepare),
/// so a cached blob is served without asking FC again. The blobs live under
/// Caches: the OS may purge them, and anything missing is simply downloaded
/// again.
public actor TurnTraceCache {
    public static let shared = TurnTraceCache(
        directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("turn-traces", isDirectory: true),
        byteLimit: 64 * 1024 * 1024
    )

    private let directory: URL
    private let byteLimit: Int

    public init(directory: URL, byteLimit: Int) {
        self.directory = directory
        self.byteLimit = byteLimit
    }

    public func read(sessionID: String, turnID: String) -> Data? {
        guard let url = fileURL(sessionID: sessionID, turnID: turnID),
              let data = try? Data(contentsOf: url)
        else { return nil }
        // Reading counts as use for eviction.
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    public func write(_ data: Data, sessionID: String, turnID: String) {
        guard let url = fileURL(sessionID: sessionID, turnID: turnID) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            return
        }
        evictIfNeeded()
    }

    public func remove(sessionID: String, turnID: String) {
        guard let url = fileURL(sessionID: sessionID, turnID: turnID) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Sign-out: another account must not read this one's traces.
    public func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func fileURL(sessionID: String, turnID: String) -> URL? {
        // Both ids become a file name; anything but a UUID is refused so a
        // crafted id can't reach outside the directory.
        guard TurnTraceLocation.isTraceableID(sessionID),
              TurnTraceLocation.isTraceableID(turnID)
        else { return nil }
        return directory.appendingPathComponent("\(sessionID.lowercased())_\(turnID.lowercased()).jsonl.gz")
    }

    private func evictIfNeeded() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: keys
        ) else { return }
        var entries = files.compactMap { url -> (url: URL, size: Int, used: Date)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(0) { $0 + $1.size }
        guard total > byteLimit else { return }
        entries.sort { $0.used < $1.used }
        for entry in entries where total > byteLimit {
            try? FileManager.default.removeItem(at: entry.url)
            total -= entry.size
        }
    }
}

/// Fetches a turn's trace: disk cache first, otherwise FC's presigned URL,
/// verified against the size and SHA-256 recorded at upload before it is
/// cached or decoded.
public struct TurnTraceLoader: Sendable {
    public typealias Download = @Sendable (URL) async throws -> (Data, HTTPURLResponse)

    /// FC refuses to presign anything larger.
    static let maxCompressedBytes = 16 * 1024 * 1024
    /// The daemon caps a trace at 8 MiB uncompressed, plus at most a couple
    /// of 256 KiB lines past that; anything far beyond is not a real trace.
    static let maxDecompressedBytes = 32 * 1024 * 1024

    private let repository: any MessagesRepository
    private let cache: TurnTraceCache
    private let download: Download

    public init(
        repository: any MessagesRepository,
        cache: TurnTraceCache = .shared,
        download: @escaping Download = TurnTraceLoader.urlSessionDownload
    ) {
        self.repository = repository
        self.cache = cache
        self.download = download
    }

    public static let urlSessionDownload: Download = { url in
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw CloudAPIError.invalidResponse }
        return (data, http)
    }

    /// The turn's trace, or nil when FC has no uploaded trace for it (older
    /// daemon, failed upload, or the pointer hasn't landed yet).
    @concurrent
    public func load(teamID: String, sessionID: String, turnID: String, senderActorID: String) async throws -> TurnTraceDetail? {
        guard !teamID.isEmpty,
              TurnTraceLocation.isTraceableID(sessionID),
              TurnTraceLocation.isTraceableID(turnID)
        else { return nil }

        if let cached = await cache.read(sessionID: sessionID, turnID: turnID) {
            if let jsonl = try? GzipDecoder.decompress(cached, maxOutputBytes: Self.maxDecompressedBytes) {
                return TurnTraceParser.parse(jsonl, turnID: turnID, senderActorID: senderActorID)
            }
            // Verified on the way in, so this is disk damage: drop it and
            // fetch a fresh copy.
            await cache.remove(sessionID: sessionID, turnID: turnID)
        }

        guard let blob = try await fetch(teamID: teamID, sessionID: sessionID, turnID: turnID) else { return nil }
        let jsonl = try GzipDecoder.decompress(blob, maxOutputBytes: Self.maxDecompressedBytes)
        return TurnTraceParser.parse(jsonl, turnID: turnID, senderActorID: senderActorID)
    }

    /// Download into the cache without decoding, so the turn detail opens
    /// without a network round trip later. Failures are left for `load` to
    /// retry and surface.
    @concurrent
    public func prefetch(teamID: String, sessionID: String, turnID: String) async {
        guard !teamID.isEmpty,
              TurnTraceLocation.isTraceableID(sessionID),
              TurnTraceLocation.isTraceableID(turnID),
              await cache.read(sessionID: sessionID, turnID: turnID) == nil
        else { return }
        _ = try? await fetch(teamID: teamID, sessionID: sessionID, turnID: turnID)
    }

    private func fetch(teamID: String, sessionID: String, turnID: String) async throws -> Data? {
        guard let location = try await repository.turnTrace(teamID: teamID, sessionID: sessionID, turnID: turnID) else {
            return nil
        }
        guard location.size <= Self.maxCompressedBytes else { throw TurnTraceError.tooLarge }
        let (data, response) = try await download(location.downloadURL)
        guard (200..<300).contains(response.statusCode) else {
            throw TurnTraceError.downloadFailed(status: response.statusCode)
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard data.count == location.size, digest == location.sha256.lowercased() else {
            throw TurnTraceError.integrityMismatch
        }
        await cache.write(data, sessionID: sessionID, turnID: turnID)
        return data
    }
}
