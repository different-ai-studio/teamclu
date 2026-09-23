import Foundation

// Turn execution traces (#1455 §7.2). At the end of every turn the daemon
// uploads one gzipped JSONL blob — thinking, tool calls with their input,
// tool results, permission requests, errors — and FC records a pointer to it
// in the turn-final reply's `messages.metadata.trace`. Clients download it
// through `GET /v1/sessions/:sid/turns/:turnId/trace`, which hands back a
// short-lived presigned URL plus the size and SHA-256 recorded at upload.

/// What `messages.metadata.trace` holds. Only turn-final agent replies carry
/// one, so its presence alone proves the turn has ended, whatever `status`
/// says.
public struct TurnTracePointer: Decodable, Equatable, Sendable {
    public let key: String
    public let size: Int
    public let sha256: String
    /// `uploaded` or `failed`.
    public let status: String

    public init(key: String, size: Int, sha256: String, status: String) {
        self.key = key
        self.size = size
        self.sha256 = sha256
        self.status = status
    }

    public var isUploaded: Bool { status == "uploaded" }
}

/// A presigned download for one turn's trace blob.
public struct TurnTraceLocation: Equatable, Sendable {
    public let downloadURL: URL
    /// Compressed size in bytes, confirmed against storage at upload.
    public let size: Int
    /// Lowercase hex SHA-256 of the compressed bytes.
    public let sha256: String

    public init(downloadURL: URL, size: Int, sha256: String) {
        self.downloadURL = downloadURL
        self.size = size
        self.sha256 = sha256
    }
}

/// One turn's trace, projected into timeline entries in trace order.
public struct TurnTraceDetail: Equatable, Sendable {
    public let entries: [TimelineEntry]
    /// Events the daemon dropped once the trace hit its size budget.
    public let droppedEvents: Int

    public init(entries: [TimelineEntry], droppedEvents: Int) {
        self.entries = entries
        self.droppedEvents = droppedEvents
    }
}

/// A trace ready for the turn detail view. The events are detached
/// `AgentEvent`s, never inserted into SwiftData.
public struct LoadedTurnTrace {
    public let events: [AgentEvent]
    public let droppedEvents: Int

    public init(events: [AgentEvent], droppedEvents: Int) {
        self.events = events
        self.droppedEvents = droppedEvents
    }

    /// The trace, followed by whatever the local rows hold past its end.
    ///
    /// Spliced by time, never reconciled event by event. Inside the span the
    /// trace covers, the daemon's record is the whole truth and the local
    /// rows are a second, finer-grained copy of the same events — merging
    /// those two produces the duplicated-head-plus-fragments mess that
    /// `pruneReplayedTurnRuntimeRows` exists to prevent. What the trace can't
    /// speak for is its own tail: it is trimmed to a size budget from the end
    /// (`droppedEvents`), and the local rows may still carry what it lost.
    public func merged(withLocal localEvents: [AgentEvent]) -> [AgentEvent] {
        guard let boundary = events.map(\.timestamp).max() else {
            return Self.chronologically(localEvents)
        }
        var tail = localEvents.filter { $0.timestamp > boundary }

        // A trimmed trace can lose the reply itself. The local reply's
        // timestamp is the turn's START (Supabase `created_at`), so it never
        // clears the boundary on its own — keep it explicitly rather than
        // render a process with no answer at the end of it.
        if !events.contains(where: { $0.eventType == "output" }),
           let reply = localEvents.last(where: { $0.eventType == "output" && $0.isComplete }),
           !tail.contains(where: { $0.id == reply.id }) {
            tail.append(reply)
        }

        guard !tail.isEmpty else { return events }
        // The trace is already in the order the daemon recorded it; only the
        // spliced tail needs ordering.
        return events + Self.chronologically(tail)
    }

    private static func chronologically(_ events: [AgentEvent]) -> [AgentEvent] {
        events.sorted { lhs, rhs in
            if lhs.timestamp != rhs.timestamp { return lhs.timestamp < rhs.timestamp }
            if lhs.sequence != rhs.sequence { return lhs.sequence < rhs.sequence }
            return lhs.id < rhs.id
        }
    }
}

public enum TurnTraceError: Error, Equatable, Sendable {
    /// The downloaded bytes don't match the size or SHA-256 FC recorded.
    case integrityMismatch
    /// Not a gzip stream this decoder understands.
    case malformedGzip
    /// Decompressed output would exceed the caller's limit.
    case tooLarge
    /// The presigned GET answered with a non-2xx status.
    case downloadFailed(status: Int)
}

extension TurnTraceLocation {
    /// Turn ids and session ids are UUIDs end to end; FC rejects anything
    /// else with 400. Checking first keeps a synthetic feed id
    /// (`turn-<event id>`) from costing a round trip.
    static func isTraceableID(_ id: String) -> Bool {
        UUID(uuidString: id) != nil
    }
}
