import Foundation

/// Where the reader left a session on this device: how far they had read,
/// and — if they left scrolled up into history — which row was at the top,
/// so reopening puts them back there instead of at the bottom.
///
/// Device-local: the server keeps a read marker but does not return it, so
/// "first unread" is as of this device until the Cloud API exposes it.
public struct SessionReadPosition: Codable, Equatable, Sendable {
    /// Newest row the reader had on screen.
    public var lastSeenAt: Date
    /// Top visible row when they left mid-history; nil when they left at
    /// the bottom (reopen at the bottom, as usual).
    public var anchorItemID: String?

    public init(lastSeenAt: Date, anchorItemID: String? = nil) {
        self.lastSeenAt = lastSeenAt
        self.anchorItemID = anchorItemID
    }
}

@MainActor
public final class SessionReadPositionStore {
    public static let shared = SessionReadPositionStore()

    private static let storageKey = "sessionReadPositions.v1"
    private let defaults: UserDefaults
    private var positions: [String: SessionReadPosition]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([String: SessionReadPosition].self, from: data) {
            positions = decoded
        } else {
            positions = [:]
        }
    }

    public func position(for sessionID: String) -> SessionReadPosition? {
        positions[sessionID]
    }

    public func save(_ position: SessionReadPosition, for sessionID: String) {
        guard !sessionID.isEmpty, positions[sessionID] != position else { return }
        positions[sessionID] = position
        persist()
    }

    /// Sign-out: another account's reading positions are meaningless.
    public func removeAll() {
        guard !positions.isEmpty else { return }
        positions = [:]
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(positions) {
            defaults.set(data, forKey: Self.storageKey)
        }
    }
}

/// The first feed row newer than `lastSeenAt` that someone else wrote, and
/// how many such rows there are. Nil when nothing is unread. The reader's
/// own messages never count — they read those as they wrote them.
public func firstUnread(
    in items: [FeedItem],
    after lastSeenAt: Date,
    excludingSender me: String?
) -> (id: String, count: Int)? {
    var first: String?
    var count = 0
    for item in items {
        guard let date = item.markerDate, date > lastSeenAt else { continue }
        if case .userMessage(let event) = item, let me, event.senderActorID == me { continue }
        if first == nil { first = item.id }
        count += 1
    }
    return first.map { ($0, count) }
}
