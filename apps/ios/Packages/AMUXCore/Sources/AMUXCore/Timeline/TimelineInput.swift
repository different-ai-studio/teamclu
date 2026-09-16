import Foundation

// MARK: - TimelineInput
//
// `SessionDetailViewModel` currently merges five event sources into a
// single `events: [AgentEvent]` array with bespoke dedupe and in-place
// mutation logic per source. `TimelineInput` is the unified sum type the
// future `ChatTimelineReducer` will consume so that ordering, identity,
// and mutation contracts are stated once and tested in isolation from
// SwiftData, MQTT, and SwiftUI.
//
// Phase 4 work order (from the architecture plan):
//   1. Land this schema + the fixture-driven tests that pin its
//      semantics. (←  this file)
//   2. Extract `ChatTimelineReducer` against the schema.
//   3. Extract `ChatTimelineStore`; migrate `SessionDetailViewModel` to
//      feed `TimelineInput` values into the store.
//
// Until step 2 lands, no production code consumes `TimelineInput`; the
// schema is reviewable as a contract while the existing inline
// handlers in `SessionDetailViewModel` keep running unchanged.
//
// ## Sources covered
//
// 1. ACP events — daemon-side stream (streaming text deltas, complete
//    output, thinking, tool_use/tool_result, permission_request,
//    plan_update, status_change, raw tool_title_update, error,
//    available_commands). Carried by `Amux_AcpEvent`.
// 2. Live chat messages — cross-actor `Teamclu_Message` (kind=text)
//    arriving over `session/{id}/live`.
// 3. History messages — `messages` rows pulled from Supabase, projected
//    into either an `agent_reply` (=output) or `user_message`/
//    `user_prompt`/`text` (=user_prompt) timeline entry.
// 4. Local prompt — the optimistic user bubble inserted by `sendPrompt`
//    before the publish round-trips through the daemon's live fanout.
//    Must round-trip through the daemon's echo so we can merge the
//    local + echoed entries into one feed item.
// 5. Permission resolution — `session_event.permission_resolved` from
//    the daemon mutating an existing `permission_request` entry.

/// One reducer-input event covering every source the timeline currently
/// merges. Apply via `ChatTimelineReducer` (forthcoming) to a
/// `[FeedItem]` state.
public enum TimelineInput: Sendable {
    case acp(AcpInput)
    case liveMessage(LiveMessageInput)
    case historyMessage(HistoryInput)
    case localPrompt(LocalPromptInput)
    case permissionResolution(PermissionResolutionInput)
}

// MARK: - Per-variant payloads

/// Daemon-side ACP event, bucketed by the producing agent's actor id —
/// `Envelope.actor_id`, which is stable across restarts and matches the
/// `sender_actor_id` the daemon persists for the same turn.
public struct AcpInput: Sendable {
    /// Monotonic per-runtime sequence stamped by the daemon. Fallback
    /// dedupe / ordering key. Not stable across daemon restarts — see
    /// `turnID` for the cross-restart identity used to dedupe completion
    /// outputs.
    public let envelopeSequence: UInt64
    /// Stable per-agent bucket used for streaming buffers, final-event
    /// attribution, and the active-stream card. Resolved at the boundary
    /// so the reducer doesn't depend on `memberSheetAgents`.
    public let agentBucketKey: String
    /// Server time the daemon stamped on the envelope. Used as the
    /// tiebreaker for ordering when sequence numbers don't apply
    /// (e.g. envelope sequence is 0 in some legacy paths).
    public let timestamp: Date
    /// Daemon-assigned per-turn correlation id (from TurnAggregator).
    /// Stable across daemon restarts and history replays, so it's the
    /// primary identity used to dedupe `output isComplete=true` events.
    /// Nil when the envelope was emitted outside an active turn
    /// (rare — some session-control envelopes), in which case the
    /// reducer falls back to `(envelopeSequence, agentBucketKey)`.
    public let turnID: String?
    /// The wrapped ACP event. The reducer matches on `event` and may
    /// produce in-place mutations (streaming-output append,
    /// tool-result pair, todo-update replace, status-change idle flush).
    public let acpEvent: Amux_AcpEvent

    public init(envelopeSequence: UInt64,
                agentBucketKey: String,
                timestamp: Date,
                turnID: String? = nil,
                acpEvent: Amux_AcpEvent) {
        self.envelopeSequence = envelopeSequence
        self.agentBucketKey = agentBucketKey
        self.timestamp = timestamp
        self.turnID = turnID
        self.acpEvent = acpEvent
    }
}

/// Cross-actor chat message arriving on `session/{id}/live`. Today only
/// `kind == .text` is rendered; other kinds are pre-filtered at the
/// boundary so the reducer doesn't carry that branch.
public struct LiveMessageInput: Sendable {
    /// Server-assigned message id. Primary dedupe key. Distinct from
    /// `clientID` on `LocalPromptInput` (the local prompt round-trips
    /// through the daemon and surfaces as a `LiveMessageInput` whose
    /// `clientLocalID` equals the prior `LocalPromptInput.clientID`).
    public let messageID: String
    /// Optional client-stamped id that round-trips from a prior
    /// `LocalPromptInput`. When set, the reducer merges the live entry
    /// onto the existing local-prompt feed item rather than appending a
    /// duplicate. Empty/nil means "no prior local prompt to merge."
    public let clientLocalID: String?
    public let senderActorID: String
    public let content: String
    public let createdAt: Date
    /// Daemon-assigned ACP turn correlation. Live agent_reply messages
    /// are filtered out at the input-builder boundary today, but the
    /// field is carried here for completeness so future
    /// kinds (or a relaxed filter) can keep the same merge semantics
    /// the history path uses.
    public let turnID: String?

    public init(messageID: String,
                clientLocalID: String? = nil,
                senderActorID: String,
                content: String,
                createdAt: Date,
                turnID: String? = nil) {
        self.messageID = messageID
        self.clientLocalID = clientLocalID
        self.senderActorID = senderActorID
        self.content = content
        self.createdAt = createdAt
        self.turnID = turnID
    }
}

public enum HistoryKind: Sendable {
    /// Past finalized turn replied by an agent.
    case output
    /// Past human message.
    case userPrompt
}

/// Past message rehydrated from Supabase. The history seed runs once
/// per session-open and on reconnect. Reducer dedupes via
/// `supabaseMessageID`.
public struct HistoryInput: Sendable {
    /// Supabase row id. Primary dedupe key — once a row has produced a
    /// feed item, a re-seed must not produce a second one.
    public let supabaseMessageID: String
    public let kind: HistoryKind
    public let senderActorID: String?
    public let content: String
    public let createdAt: Date
    public let model: String?
    /// Daemon-assigned ACP turn correlation. When the same turnID arrives
    /// across multiple rows (daemon flushed a turn into 2+ AgentReply
    /// rows because ToolUse cut it short mid-stream), the reducer merges
    /// them into one entry instead of producing two separate bubbles.
    /// nil for pre-turn_id Supabase rows.
    public let turnID: String?
    /// Daemon's per-runtime envelope sequence stamped on this row. Used
    /// by the reducer to set `AgentEvent.sequence` so cross-source ordering
    /// (Supabase seed vs. live MQTT deltas) is stable. 0 = legacy row
    /// without sequence; reducer falls back to (createdAt, supabaseMessageID).
    public let sequence: Int64
    /// The row carries `metadata.trace`, which the daemon attaches only to a
    /// turn's final reply: the turn `turnID` has ended.
    public let closesTurn: Bool

    public init(supabaseMessageID: String,
                kind: HistoryKind,
                senderActorID: String?,
                content: String,
                createdAt: Date,
                model: String? = nil,
                turnID: String? = nil,
                sequence: Int64 = 0,
                closesTurn: Bool = false) {
        self.supabaseMessageID = supabaseMessageID
        self.kind = kind
        self.senderActorID = senderActorID
        self.content = content
        self.createdAt = createdAt
        self.model = model
        self.turnID = turnID
        self.sequence = sequence
        self.closesTurn = closesTurn
    }
}

/// Local optimistic user bubble inserted at compose time. Reducer adds
/// it to the feed immediately so the composer can clear. When the
/// daemon's live echo arrives as a `LiveMessageInput` carrying the same
/// `clientID`, the reducer merges them; if no echo arrives within the
/// outbox's retry budget, the bubble stays but is rendered as orphaned
/// (UI concern — reducer just records the lonely local prompt).
public struct LocalPromptInput: Sendable {
    /// Client-generated uuid stamped at compose time. Round-trips to the
    /// daemon, returns inside the live echo's `clientLocalID`.
    public let clientID: String
    public let senderActorID: String
    public let content: String
    public let createdAt: Date

    public init(clientID: String,
                senderActorID: String,
                content: String,
                createdAt: Date) {
        self.clientID = clientID
        self.senderActorID = senderActorID
        self.content = content
        self.createdAt = createdAt
    }
}

/// User answered a daemon-issued `permission_request`. Reducer updates
/// the existing permission feed item in-place; if no matching item
/// exists (out-of-order arrival), the resolution is dropped silently.
public struct PermissionResolutionInput: Sendable {
    public let requestID: String
    public let granted: Bool

    public init(requestID: String, granted: Bool) {
        self.requestID = requestID
        self.granted = granted
    }
}

// MARK: - Reducer contract
//
// What follows is the contract the `ChatTimelineReducer` must honour.
// It is documented here (not in the reducer file) because the schema
// owns the contract; the reducer is the implementation. Fixture tests
// in `TimelineInputTests` pin each rule against representative
// scenarios so regressions show up as test failures.
//
// ## Ordering
//
// The reducer must produce a deterministic `[FeedItem]` for any
// permutation of inputs that share a logical ordering. The ordering key
// per variant:
//
//   - `.acp`           → (agentBucketKey, envelopeSequence) primary;
//                        `timestamp` tiebreaker when sequence==0.
//   - `.liveMessage`   → `createdAt`.
//   - `.historyMessage`→ `createdAt`.
//   - `.localPrompt`   → `createdAt` (local clock).
//   - `.permissionResolution` → no ordering of its own; applied to the
//                        prior `.acp(permissionRequest)` entry.
//
// Across variants, the canonical ordering is:
//
//   1. ACP events sorted by `(agentBucketKey, envelopeSequence)`, then
//      tiebroken by `timestamp`.
//   2. Cross-variant messages (live, history, local prompt) interleaved
//      by `createdAt`.
//   3. When a live or history entry shares its content + timestamp
//      slot with a local prompt that carries the same `clientID` /
//      content fingerprint, they merge into one item rather than
//      appearing twice (see Identity below).
//
// The reducer must be idempotent under replay: applying the same input
// twice produces the same state. (Implementation: dedupe via the
// identity keys below; in-place updates re-applied with the same value
// are no-ops.)
//
// ## Identity / dedupe
//
//   - `.acp`           → `(agentBucketKey, envelopeSequence)` is the
//                        replay-dedupe key. Same (runtime, sequence)
//                        applied twice is a no-op.
//   - `.liveMessage`   → `messageID`.
//   - `.historyMessage`→ `supabaseMessageID`. On re-seed, the existing
//                        feed item is left untouched.
//   - `.localPrompt`   → `clientID`. Re-feeding the same clientID is
//                        a no-op.
//   - `.permissionResolution` → keyed on `requestID`; targets an
//                        existing `permissionRequest` feed item.
//
// ## In-place mutation cases
//
// The reducer represents the timeline as `[FeedItem]` and applies the
// following in-place updates rather than appending duplicates:
//
//   1. Streaming output delta: each `acp` with `output { isComplete = false }`
//      appends `text` onto the open partial-output entry for the
//      `agentBucketKey`. The first delta of a stream drops any
//      prior synthetic stop()-saved entry for that bucket. A subsequent
//      `output { isComplete = true }` finalises in place.
//
//   2. Tool result pairing: `acp` with `toolResult(toolID)` finds the
//      prior `tool_use(toolID)` entry and stamps `success` +
//      `isComplete` on it. If no prior `tool_use` exists, append a new
//      tool_result entry (out-of-order arrival).
//
//   3. Plan update: `acp` with `planUpdate` replaces the single
//      `plan_update` entry's text. If none exists, append.
//
//   4. Permission resolve: `.permissionResolution(requestID)` finds the
//      prior `permissionRequest(requestID)` entry and marks it
//      `isComplete = true` with `success = granted`. Drop silently if
//      no matching entry.
//
//   5. Status change to idle: flush any open streaming output buffer
//      for that runtime's `agentBucketKey` into a final entry, then
//      reset the buffer. Other agents' streams are unaffected.
//
//   6. Local prompt + live echo merge: when a `.liveMessage(clientLocalID: X)`
//      arrives and a prior `.localPrompt(clientID: X)` produced a feed
//      item, the live entry overwrites the local one in place
//      (replacing the temporary client id with the server messageID
//      so future history seeds match). The local prompt does NOT
//      produce a second feed item.
//
//   7. History + live cross-dedupe: when a `.historyMessage` arrives
//      for a turn whose content already exists in the timeline (live
//      stream completed before the history seed ran), backfill the
//      `supabaseMessageID` onto the existing item rather than
//      appending. Match is content-equal within the agent bucket.
