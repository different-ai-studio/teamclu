import Foundation
import SwiftData

@Model
public final class Session {
    @Attribute(.unique) public var sessionId: String
    public var teamId: String
    public var title: String
    public var createdBy: String
    public var createdAt: Date
    public var summary: String
    public var participantCount: Int
    public var lastMessagePreview: String
    public var lastMessageAt: Date?
    public var ideaId: String
    public var primaryAgentId: String?
    /// User-pinned: floats to the top "Pinned" group in the session list.
    /// Local-only (not synced to Supabase yet).
    public var isPinned: Bool = false
    /// User-archived: hidden from the main session list. Soft-delete only;
    /// no unarchive UI yet. Local-only.
    public var isArchived: Bool = false
    /// Set by NewSessionSheet to the first user message, cleared once the
    /// session/live publish succeeds. The detail view treats this as a
    /// "loading" gate: composer disabled while non-nil so the user can't
    /// race in a second message before the first one has been delivered.
    public var pendingFirstMessage: String?
    /// Server-driven unread flag, computed by `list_current_actor_sessions`
    /// (sessions.last_message_at > session_read_markers.last_read_at).
    /// Set on inbox MQTT ping (FC fan-out after message INSERT); cleared
    /// when the user opens the session via `mark_current_actor_session_viewed`.
    /// The only unread signal. A local client-side flag used to be OR'd in,
    /// but it rode on fields the actor retain does not carry (ADR-0004).
    public var hasUnread: Bool = false
    /// Agent actorIDs the user has selected via the composer's `[@]` button or
    /// inline `@` mention. Persisted so reopening the session restores
    /// selection. Empty array preserves broadcast semantics on send (mention
    /// all agents on the daemon side).
    public var selectedAgentIds: [String] = []
    /// Session-level "full access": incoming ACP permission requests are
    /// auto-granted (allow-once) instead of waiting on a tap. Local-only,
    /// mirroring the desktop's per-session permission mode — the daemon is
    /// never told; the client just answers on the user's behalf.
    public var autoApprovePermissions: Bool = false
    /// How the session was created: `user` | `cron` | `gateway` (empty on
    /// rows synced before the column existed). The list hides `cron`
    /// sessions unless the scheduled-sessions view is toggled on,
    /// mirroring the desktop's clock view.
    public var source: String = ""
    /// The app this session was created from (`sessions.app_id`); empty for
    /// ordinary sessions.
    public var appId: String = ""
    /// Cached names for the session list's third line. Written on refresh
    /// (`SessionListViewModel.applyAppNames` / `applyIdeaTitles`) and kept
    /// across launches, so the row names its app or idea before the network
    /// answers. May lag a rename until the next refresh.
    public var appName: String = ""
    public var ideaTitle: String = ""

    public init(
        sessionId: String,
        teamId: String = "",
        title: String = "",
        createdBy: String = "",
        createdAt: Date = .now,
        summary: String = "",
        participantCount: Int = 0,
        lastMessagePreview: String = "",
        lastMessageAt: Date? = nil,
        ideaId: String = "",
        isPinned: Bool = false,
        isArchived: Bool = false,
        pendingFirstMessage: String? = nil,
        hasUnread: Bool = false
    ) {
        self.sessionId = sessionId
        self.teamId = teamId
        self.title = title
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.summary = summary
        self.participantCount = participantCount
        self.lastMessagePreview = lastMessagePreview
        self.lastMessageAt = lastMessageAt
        self.ideaId = ideaId
        self.isPinned = isPinned
        self.isArchived = isArchived
        self.pendingFirstMessage = pendingFirstMessage
        self.hasUnread = hasUnread
    }
}
