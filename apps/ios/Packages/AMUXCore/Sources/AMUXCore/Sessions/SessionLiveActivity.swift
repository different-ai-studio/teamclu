import Foundation

/// What the session list's leading dot says about one session.
///
/// Two questions, in priority order: *is someone waiting on me?* and *is an
/// agent working?* Everything else is quiet. Deliberately not a mirror of
/// `AgentStatus` — `Starting`, `Idle`, `Stopped` and "cold" all read the same
/// to a person scanning the list, so they collapse into one case.
public enum SessionLiveActivity: String, Sendable, Equatable {
    /// Nothing is happening, or nothing is known yet.
    case quiet
    /// An agent is mid-turn.
    case running
    /// An agent is blocked on a permission grant or a question.
    case needsAttention
}

/// The signals `session/{id}/live` carries that move the dot.
///
/// The raw stream is far wider than this — output deltas, plan updates,
/// tool titles. Reducing to five cases first means the state machine below
/// is testable without building protobuf envelopes, and means a new ACP
/// event type lands as `.progress` (harmless) rather than as a crash or a
/// stuck dot.
public enum SessionLiveSignal: Equatable, Sendable {
    /// The agent picked the turn up: an explicit `statusChange → active`.
    case turnStarted
    /// The turn closed: `statusChange → idle | stopped | error`.
    case turnEnded
    /// Mid-turn traffic (output, thinking, tool calls). Implies a turn is
    /// open — daemons do not always emit a leading `statusChange`.
    case progress
    /// A permission request or an agent question is waiting on a person.
    case attentionRequested(id: String)
    /// That request was answered, denied, or cancelled — by anyone, on any
    /// device. The daemon also sends this when it tears an attachment down
    /// with requests still open.
    case attentionResolved(id: String)
    /// Traffic that keeps the session "hot" for the subscription sweeper but
    /// says nothing about the dot (chat messages, title updates).
    case idleChatter
}

// MARK: - Per-session state

/// Reduced live state for one session. Value type on purpose: the store holds
/// a dictionary of these and SwiftUI diffs them by equality.
public struct SessionActivityState: Equatable, Sendable {
    /// A turn is open. Set by `.turnStarted` / `.progress`, cleared by
    /// `.turnEnded`.
    public private(set) var isRunning: Bool = false
    /// Open permission / question request ids. A set, not a flag: two tools
    /// can be pending at once, and resolving one must not clear the other.
    public private(set) var pendingRequestIDs: Set<String> = []
    /// Last signal of any kind. Drives both the running watchdog and the
    /// subscription sweeper.
    public private(set) var lastSignalAt: Date

    public init(lastSignalAt: Date = .distantPast) {
        self.lastSignalAt = lastSignalAt
    }

    public var activity: SessionLiveActivity {
        if !pendingRequestIDs.isEmpty { return .needsAttention }
        return isRunning ? .running : .quiet
    }

    /// True while this session still justifies holding its `session/live`
    /// subscription open. A pending request has no timeout of its own — it
    /// stays until someone answers it — so it pins the subscription.
    public func isHot(now: Date, quietGrace: TimeInterval) -> Bool {
        if !pendingRequestIDs.isEmpty { return true }
        if isRunning { return true }
        return now.timeIntervalSince(lastSignalAt) < quietGrace
    }

    public mutating func apply(_ signal: SessionLiveSignal, at timestamp: Date) {
        lastSignalAt = timestamp
        switch signal {
        case .turnStarted, .progress:
            isRunning = true
        case .turnEnded:
            isRunning = false
        case .attentionRequested(let id):
            guard !id.isEmpty else { return }
            pendingRequestIDs.insert(id)
            // A request only exists inside an open turn, and the turn resumes
            // once it is answered — so the dot goes back to green rather than
            // to grey on resolve.
            isRunning = true
        case .attentionResolved(let id):
            guard !id.isEmpty else { return }
            pendingRequestIDs.remove(id)
        case .idleChatter:
            break
        }
    }

    /// Drops a `running` flag whose turn never announced its end.
    ///
    /// `statusChange → idle` rides QoS1, but an attachment killed mid-turn
    /// (daemon crash, machine asleep, `session/live` dropped while the phone
    /// was backgrounded) sends nothing at all. Without this the dot stays
    /// green for the rest of the app's life. Pending requests are exempt:
    /// silence is exactly what a blocked turn looks like.
    public mutating func expireStaleRun(now: Date, timeout: TimeInterval) -> Bool {
        guard isRunning, pendingRequestIDs.isEmpty else { return false }
        guard now.timeIntervalSince(lastSignalAt) >= timeout else { return false }
        isRunning = false
        return true
    }
}

// MARK: - Envelope → signal

public enum SessionLiveSignalDecoder {
    /// Maps one `session/{id}/live` envelope onto a dot signal.
    ///
    /// Returns nil only when the envelope itself fails to decode — an
    /// unrecognized *event* maps to `.idleChatter`, so a daemon that starts
    /// publishing something new never strands the dot.
    public static func signal(
        from envelope: Teamclu_LiveEventEnvelope
    ) -> SessionLiveSignal? {
        guard envelope.eventType == "acp.event" else {
            // `message.created`, `session.title_updated`, idea events: real
            // traffic, but none of it says an agent is working. The agent's
            // own reply lands at turn *end*, so treating it as `.progress`
            // would re-open a turn that just closed.
            return .idleChatter
        }
        guard let amux = try? Amux_Envelope(serializedBytes: envelope.body) else {
            return nil
        }
        switch amux.payload {
        case .acpEvent(let acp):
            return signal(fromACP: acp)
        case .sessionEvent(let session):
            return signal(fromSession: session)
        case .none:
            return .idleChatter
        }
    }

    static func signal(fromACP acp: Amux_AcpEvent) -> SessionLiveSignal {
        switch acp.event {
        case .statusChange(let change):
            switch change.newStatus {
            case .active:
                return .turnStarted
            case .idle, .stopped, .error:
                return .turnEnded
            // `Starting` is the attachment spinning up, not a turn; leave the
            // dot where it is rather than claiming work that hasn't begun.
            case .starting, .unknown, .UNRECOGNIZED:
                return .idleChatter
            }

        case .permissionRequest(let request):
            return .attentionRequested(id: request.requestID)

        // The agent's `question` tool arrives as raw JSON, not as its own ACP
        // event — pi tunnels it through a marked `select` dialog
        // (`apps/daemon/src/runtime/pi_rpc/translate.rs:497`).
        case .raw(let raw) where raw.method == "question_asked":
            guard let id = questionRequestID(raw.jsonPayload) else { return .idleChatter }
            return .attentionRequested(id: id)

        case .raw(let raw) where raw.method == "question_replied"
            || raw.method == "question_rejected":
            guard let id = questionRequestID(raw.jsonPayload) else { return .idleChatter }
            return .attentionResolved(id: id)

        case .output, .thinking, .toolUse, .toolResult, .planUpdate:
            return .progress

        case .error, .availableCommands, .raw, .none:
            return .idleChatter
        }
    }

    static func signal(fromSession event: Amux_SessionEvent) -> SessionLiveSignal {
        switch event.event {
        case .permissionResolved(let resolved):
            return .attentionResolved(id: resolved.requestID)
        case .promptAccepted:
            return .progress
        case .promptRejected, .historyBatch, .none:
            return .idleChatter
        }
    }

    /// `question_asked` keys the id as `id`; the reply events use `requestID`
    /// and fall back to `id`. Mirrors `SessionDetailViewModel`'s parser —
    /// same wire shape, read for one field instead of the whole prompt.
    static func questionRequestID(_ data: Data) -> String? {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let id = (payload["requestID"] as? String) ?? (payload["id"] as? String)
        guard let id, !id.isEmpty else { return nil }
        return id
    }
}
