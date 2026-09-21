import Foundation

/// One reducer entry — a value-type mirror of the parts of `AgentEvent`
/// the timeline UI actually reads. `ChatTimelineReducer` mutates a
/// `TimelineState` over `TimelineInput`s; the surrounding store
/// translates between `TimelineEntry` and the SwiftData `AgentEvent`
/// row.
///
/// The split exists so the reducer can be tested without SwiftData
/// (insertion / persistence is the store's concern). When the rest of
/// Phase 4 lands the production code, view rendering will move to
/// `TimelineEntry` and `AgentEvent` becomes a pure persistence row.
public struct TimelineEntry: Identifiable, Equatable, Sendable {
    public var id: String
    public var sequence: UInt64
    public var eventType: String
    public var text: String?
    public var toolID: String?
    public var toolName: String?
    public var isComplete: Bool
    public var success: Bool?
    public var senderActorID: String?
    public var timestamp: Date
    public var model: String?
    public var supabaseMessageID: String?
    /// Round-trip id stamped by the composer on a local prompt; the
    /// daemon's live echo carries this back so the reducer can merge
    /// the optimistic bubble with the authoritative live entry instead
    /// of showing two.
    public var clientID: String?
    /// Bridge from a user_prompt bubble to its `OutboxMessage` row when
    /// the message originated locally. The chat detail view looks up
    /// the outbox row by this id to render the status-dot accessory
    /// (pending / delivered / failed). Mirrors `AgentEvent.outboxMessageID`.
    public var outboxMessageID: String?
    /// Daemon-assigned correlation id for the ACP turn this entry
    /// belongs to. Stamped by the daemon's TurnAggregator on emit and
    /// carried on the wire (`Teamclu_Message.turnId`). Multiple
    /// consecutive agent_reply entries sharing the same turnID came
    /// out of one logical turn — the reducer's history path merges
    /// them so reload doesn't split a single answer across two bubbles.
    /// nil for pre-turn_id rows and for user_prompt — a turn is the agent's,
    /// not the user's. permission_request DOES carry one; `applyAcp` stamps
    /// it from the envelope, and `buildFeedItems` needs it to know which
    /// turn's card the request belongs under.
    public var turnID: String?
    /// Result summary text from the matching `ToolResult` envelope,
    /// written onto a `tool_use` entry when the result arrives. nil while
    /// the tool is still running or for non-tool_use rows. Renders as an
    /// embedded disclosure under the tool card in the turn detail view.
    public var resultSummary: String?
    /// First `AcpToolCallDiff` content block carried by the tool's
    /// ToolUse/ToolResult envelope: the file the agent edited plus the
    /// before/after text. nil for tools that carry no diff. One diff per
    /// entry is deliberate — ACP edit tools emit exactly one, and the
    /// mobile card renders one file.
    public var diffPath: String?
    public var diffOldText: String?
    public var diffNewText: String?
    /// Files this message carries, from `messages.attachments`. Only the
    /// history path fills it — live ACP envelopes have no attachment channel
    /// of their own. Empty for rows written before the column was plumbed
    /// through; those have their URLs inlined in `text` instead.
    public var attachments: [MessageAttachment] = []

    public init(id: String = UUID().uuidString,
                sequence: UInt64 = 0,
                eventType: String,
                text: String? = nil,
                toolID: String? = nil,
                toolName: String? = nil,
                isComplete: Bool = false,
                success: Bool? = nil,
                senderActorID: String? = nil,
                timestamp: Date = .now,
                model: String? = nil,
                supabaseMessageID: String? = nil,
                clientID: String? = nil,
                outboxMessageID: String? = nil,
                turnID: String? = nil,
                resultSummary: String? = nil,
                diffPath: String? = nil,
                diffOldText: String? = nil,
                diffNewText: String? = nil,
                attachments: [MessageAttachment] = []) {
        self.id = id
        self.sequence = sequence
        self.eventType = eventType
        self.text = text
        self.toolID = toolID
        self.toolName = toolName
        self.isComplete = isComplete
        self.success = success
        self.senderActorID = senderActorID
        self.timestamp = timestamp
        self.model = model
        self.supabaseMessageID = supabaseMessageID
        self.clientID = clientID
        self.outboxMessageID = outboxMessageID
        self.turnID = turnID
        self.resultSummary = resultSummary
        self.diffPath = diffPath
        self.diffOldText = diffOldText
        self.diffNewText = diffNewText
        self.attachments = attachments
    }
}

/// The reducer's state: the timeline entries plus the streaming-buffer
/// scratch space tracked while an open turn is mid-flight.
public struct TimelineState: Equatable, Sendable {
    public var entries: [TimelineEntry] = []

    /// Per-agent open-turn streaming text, accumulated across delta
    /// arrivals until `.output(isComplete: true)` or an idle status
    /// change for that runtime flushes it.
    public var streamingTextByAgent: [String: String] = [:]

    /// Per-agent model id seen on the latest delta. Stamped onto the
    /// finalised output entry on flush.
    public var streamingModelByAgent: [String: String] = [:]

    /// Agents currently mid-stream. Used by the view to surface an
    /// active-stream card. Population is keyed off the first delta of
    /// a turn; depopulation off the matching `isComplete=true` /
    /// `status_change=idle`.
    public var streamingAgentSet: Set<String> = []

    /// Per-agent active turn id while a stream is in flight, captured
    /// on the first delta of the turn. The MQTT subscribe loop reads
    /// this on reconnect to call `requestTurnHistory(...)` for any
    /// agent whose stream the broker may have left mid-turn — replays
    /// the missing envelopes (including the trailing
    /// `status_change=idle`) so the activeStream card clears instead
    /// of hanging until the user pulls-to-refresh. Cleared in lockstep
    /// with `streamingAgentSet` whenever the turn finalises.
    public var streamingTurnIDByAgent: [String: String] = [:]

    /// Most recent slash-command catalog the daemon advertised. The
    /// composer's popup reads this directly.
    public var availableCommands: [SlashCommand] = []

    public init(entries: [TimelineEntry] = [],
                streamingTextByAgent: [String: String] = [:],
                streamingModelByAgent: [String: String] = [:],
                streamingAgentSet: Set<String> = [],
                streamingTurnIDByAgent: [String: String] = [:],
                availableCommands: [SlashCommand] = []) {
        self.entries = entries
        self.streamingTextByAgent = streamingTextByAgent
        self.streamingModelByAgent = streamingModelByAgent
        self.streamingAgentSet = streamingAgentSet
        self.streamingTurnIDByAgent = streamingTurnIDByAgent
        self.availableCommands = availableCommands
    }
}
