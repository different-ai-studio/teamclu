import Foundation

// Protocols + record types for the session-list / messages / runtimes
// repositories. Relocated out of the deleted Supabase implementations;
// the Cloud API implementations live in CloudAPI/CloudAPIRepositories.swift.


public struct SessionRecord: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let ideaID: String?
    public let createdByActorID: String
    public let primaryAgentID: String?
    public let mode: String
    public let title: String
    public let summary: String
    public let participantCount: Int
    public let lastMessagePreview: String
    public let lastMessageAt: Date?
    public let createdAt: Date
    /// How the session was created: `user` | `cron` | `gateway`. nil on
    /// rows from servers predating the column. The list hides `cron`
    /// sessions by default, mirroring the desktop.
    public let source: String?
    /// The app this session belongs to (`sessions.app_id`); nil for ordinary
    /// sessions and on servers predating the list column.
    public var appID: String? = nil
}

public protocol SessionsRepository: Sendable {
    func listSessions(teamID: String) async throws -> [SessionRecord]
    /// Returns the `(session_id, has_unread)` map computed server-side by
    /// `list_current_actor_sessions` (sessions.last_message_at > session_read_markers.last_read_at).
    /// Used by the inbox red-dot feature to authoritatively know which
    /// sessions have unseen peer messages without each client tracking the
    /// state locally.
    ///
    /// `teamID` is required: the server resolves the caller's actor per team
    /// (one actor row per user per team), so an unscoped call has no identity
    /// to compute unread state against.
    func fetchUnreadFlags(teamID: String, limit: Int) async throws -> [String: Bool]
    /// Marks the current actor as having viewed `sessionId` up to
    /// `lastReadMessageId`. Server upserts `session_read_markers` so other
    /// devices' next `fetchUnreadFlags` reflects the read.
    func markSessionViewed(sessionId: String, lastReadMessageId: String?) async throws
    /// Inverse of `markSessionViewed`: rewinds the actor's read marker so
    /// the session surfaces as unread again on every device's next
    /// `fetchUnreadFlags`. The actor is resolved server-side from the
    /// bearer token — no body.
    func markSessionUnread(sessionId: String) async throws
    /// Renames the session for every participant (`PATCH /v1/sessions/:id`).
    func renameSession(sessionId: String, title: String) async throws
    /// Sets (or clears, when nil) the server-side `archived_at`. The session
    /// list RPC only returns rows with `archived_at is null`, so archiving
    /// removes the session from every device's list on its next refresh —
    /// not just from this one.
    func setSessionArchived(sessionId: String, archivedAt: Date?) async throws
}



/// Fetches the canonical set of session IDs for a team from Supabase.
/// Used to filter out stale MQTT-era rows that still live in local SwiftData
/// but no longer exist in the authoritative backend.
public protocol SessionIDsRepository: Sendable {
    func listSessionIDs(teamID: String) async throws -> Set<String>
}



/// Snapshot of a Supabase `messages` row for the session-resume seed
/// path. Only the fields the iOS UI actually needs to render a past
/// turn (user prompt or finalized agent reply) are pulled — tool calls,
/// thinking deltas, and other intermediate ACP events are intentionally
/// not represented here.
public struct MessageRecord: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let sessionID: String
    public let senderActorID: String
    public let kind: String
    public let content: String
    public let createdAt: Date
    public let updatedAt: Date?
    /// Model id is currently stored inside `messages.metadata` JSON; not
    /// surfaced through the seed today. Left nil here until we add a typed
    /// metadata path.
    public let model: String?
    /// Daemon-assigned ACP turn correlation. Same value across rows the
    /// daemon flushed from one turn (ToolUse mid-stream causes a flush
    /// + a continuation flush at Active→Idle). The seed path uses this
    /// to merge those rows into a single bubble. nil for pre-turn_id
    /// rows or non-agent kinds.
    public let turnID: String?
    public let replyToMessageID: String?
    /// Chip-bar mentions the sender attached, decoded from
    /// `messages.metadata.mention_actor_ids`. Empty when the row carries
    /// no metadata — distinguishing directed from broadcast turns.
    public let mentionActorIDs: [String]
    /// Daemon-assigned per-runtime envelope sequence, stamped on every
    /// emit by `emit_agent_message`. Stable order across multi-runtime
    /// fanouts where `created_at` would collide. 0 means "legacy row
    /// before the column existed" — fall back to created_at ordering.
    public let sequence: Int64
    /// `messages.metadata.trace`: where this turn's execution trace lives.
    /// Only turn-final agent replies carry one, and it lands a few seconds
    /// after the reply itself, so nil does not mean the turn has no trace.
    public var trace: TurnTracePointer? = nil
    /// `messages.attachments`: files carried by this message, structured.
    /// Empty for everything written before the column was plumbed through —
    /// those messages have their URLs inlined in `content` instead.
    public var attachments: [MessageAttachment] = []
}

/// Input shape for inserting a chat message into Supabase. iOS writes
/// human prompts here so collaborators on cold-launch get a complete
/// session history (the daemon only persists agent replies). RLS
/// `messages_insert_if_session_participant` gates on `sender_actor_id ==
/// app.current_actor_id()` and the caller's session-participant status.
public struct MessageInsertInput: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let sessionID: String
    public let senderActorID: String
    public let kind: String
    public let content: String
    /// Actor ids of chip-bar mentions. Stored in `messages.metadata` as
    /// `{"mention_actor_ids": [...]}` so the daemon can query historical
    /// routing context and the seed path can reconstruct directed vs
    /// broadcast turn groupings.
    public let mentionActorIDs: [String]
    /// Files this message carries, written to `messages.attachments`. The
    /// same URLs also ride on `Teamclu_Message.attachment_urls` for the
    /// daemon to feed the agent; this is the copy that survives on the row.
    public let attachments: [MessageAttachment]

    public init(
        id: String = UUID().uuidString.lowercased(),
        teamID: String,
        sessionID: String,
        senderActorID: String,
        kind: String = "text",
        content: String,
        mentionActorIDs: [String] = [],
        attachments: [MessageAttachment] = []
    ) {
        self.id = id
        self.teamID = teamID
        self.sessionID = sessionID
        self.senderActorID = senderActorID
        self.kind = kind
        self.content = content
        self.mentionActorIDs = mentionActorIDs
        self.attachments = attachments
    }
}

/// One page of history, walking backward from the newest message.
///
/// `messages` is oldest-first (transcript order); `nextCursor` reaches the page
/// immediately OLDER than this one and is nil at the start of the session.
public struct MessagePage: Sendable {
    public let messages: [MessageRecord]
    public let nextCursor: String?

    public init(messages: [MessageRecord], nextCursor: String?) {
        self.messages = messages
        self.nextCursor = nextCursor
    }
}

public protocol MessagesRepository: Sendable {
    func listForSession(sessionID: String) async throws -> [MessageRecord]
    /// Paginated history. `GET /v1/sessions/:id/messages` used to return a
    /// session's entire history in one response — 6k messages measured
    /// 6.1s / 3.7MB and 40k exceeded the server's statement timeout — so it now
    /// serves the newest page and pages backward from there.
    func listPage(sessionID: String, limit: Int?, cursor: String?) async throws -> MessagePage
    func insert(_ input: MessageInsertInput) async throws
    /// Rewrites a persisted message's content. FC enforces sender-only
    /// semantics, so callers only offer this for the current actor's own
    /// rows — a 403 here is a programming error, not a user race.
    func patch(messageID: String, content: String) async throws
    /// Permanently removes a persisted message (FC returns 204).
    /// Same sender-only contract as `patch`.
    func delete(messageID: String) async throws
    /// Submits (upserts) 👍/👎 feedback for an assistant message
    /// (`POST /v1/feedback`). `kind` is `"positive"` or `"negative"`.
    func submitFeedback(_ input: FeedbackInput) async throws
    /// Removes the caller's feedback for a message
    /// (`DELETE /v1/feedback/:id?actorId=`). `actorID` scopes the delete to
    /// the caller's own row — without it the pg backend removes every
    /// actor's feedback for the message.
    func deleteFeedback(messageID: String, actorID: String) async throws
    /// Existing feedback rows for a session (`GET /v1/feedback?sessionId=`).
    /// Includes every actor's rows; callers filter to the current actor.
    func listFeedback(sessionID: String) async throws -> [FeedbackRecord]
    /// Presigned download for a turn's execution trace
    /// (`GET /v1/sessions/:id/turns/:turnId/trace`). nil when FC has no
    /// uploaded trace for the turn (404).
    func turnTrace(teamID: String, sessionID: String, turnID: String) async throws -> TurnTraceLocation?
}

public struct FeedbackInput: Sendable {
    public let messageID: String
    public let actorID: String
    public let teamID: String
    public let sessionID: String?
    /// "positive" | "negative"
    public let kind: String
    public let starRating: Int?

    public init(messageID: String, actorID: String, teamID: String,
                sessionID: String?, kind: String, starRating: Int? = nil) {
        self.messageID = messageID
        self.actorID = actorID
        self.teamID = teamID
        self.sessionID = sessionID
        self.kind = kind
        self.starRating = starRating
    }
}

public struct FeedbackRecord: Sendable, Equatable {
    public let messageID: String
    public let actorID: String
    public let kind: String

    public init(messageID: String, actorID: String, kind: String) {
        self.messageID = messageID
        self.actorID = actorID
        self.kind = kind
    }
}

public extension MessagesRepository {
    /// Default for repositories that have nothing to page (in-memory fakes,
    /// tests): serve everything as a single, final page.
    func listPage(sessionID: String, limit: Int? = nil, cursor: String? = nil) async throws -> MessagePage {
        _ = limit
        _ = cursor
        return MessagePage(messages: try await listForSession(sessionID: sessionID), nextCursor: nil)
    }
}





