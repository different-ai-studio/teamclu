import Foundation
import Observation
import SwiftData

public struct SlashCommand: Identifiable, Equatable, Hashable, Sendable, Codable {
    public let name: String
    public let description: String
    public let inputHint: String   // "" = no input required
    public var id: String { name }

    public init(name: String, description: String, inputHint: String) {
        self.name = name
        self.description = description
        self.inputHint = inputHint
    }
}

public struct AcpQuestionOption: Identifiable, Equatable, Sendable {
    public let label: String
    public let description: String
    public var id: String { label }
}

public struct AcpQuestionPrompt: Identifiable, Equatable, Sendable {
    public let id: String
    public let header: String
    public let question: String
    public let options: [AcpQuestionOption]
    public let allowsMultiple: Bool
}

public struct PendingAcpQuestion: Identifiable, Equatable, Sendable {
    public let id: String
    public let agentActorID: String
    public let questions: [AcpQuestionPrompt]
}

@Observable @MainActor
public final class SessionDetailViewModel {
    public var events: [AgentEvent] = []
    /// Slash commands announced by the attached runtime via
    /// ACP `AvailableCommandsUpdate`. Replaced wholesale on each push.
    /// In-memory only — not persisted to SwiftData. Empty until the
    /// agent's `AvailableCommandsUpdate` lands (or its retained state
    /// topic is consumed), at which point `availableCommands` switches
    /// from the built-in fallback set to the agent-provided list.
    private var dynamicAvailableCommands: [SlashCommand] = []

    /// Slash commands surfaced to the composer popup. Returns the
    /// agent-provided list when the runtime has announced any; otherwise
    /// returns a small built-in set so `/` always shows something useful
    /// (the most common Claude Code built-ins). The composer's
    /// `recomputeSlashCandidates` re-runs whenever this changes.
    public var availableCommands: [SlashCommand] {
        if !dynamicAvailableCommands.isEmpty {
            return dynamicAvailableCommands
        }
        return Self.builtInSlashCommands
    }

    /// Universal fallback so the popup is usable before (or instead of)
    /// the agent emitting `AvailableCommandsUpdate`. Names match Claude
    /// Code's built-ins; sending one forwards the literal `/name` text to
    /// the agent which interprets it natively.
    static let builtInSlashCommands: [SlashCommand] = [
        SlashCommand(name: "clear", description: String(localized: "Clear conversation history"), inputHint: ""),
        SlashCommand(name: "compact", description: String(localized: "Compact the conversation"), inputHint: ""),
        SlashCommand(name: "help", description: String(localized: "Show available commands"), inputHint: ""),
        SlashCommand(name: "model", description: String(localized: "Switch the active model"), inputHint: ""),
        SlashCommand(name: "cost", description: String(localized: "Show session token cost"), inputHint: ""),
    ]
    /// Memoised tool-run grouping over `events`. Views should iterate this
    /// instead of calling `groupEvents(vm.events)` in body, which previously
    /// made grouping O(n) on every streaming delta frame. Recomputed by
    /// `recomputeGroups()` at each mutation site.
    public private(set) var groupedEvents: [GroupedEvent] = []
    /// Higher-level feed grouping that hides per-turn runtime detail
    /// (thinking / tool_use / tool_result) behind active-stream cards or
    /// completed-turn bubbles. Source for the main chat list. Detail view
    /// reads `runtimeEvents` off each item to render the full turn.
    public private(set) var feedItems: [FeedItem] = []
    /// True after `start(modelContext:)` has loaded the initial local event
    /// snapshot and projected it into `feedItems`. The detail view uses this
    /// to reveal the scroll view only after the first real layout pass can
    /// anchor against actual content.
    public private(set) var hasLoadedInitialFeed: Bool = false
    /// Per-agent streaming output buffer. Keyed by the agent actor id. An
    /// entry exists only between the first delta of an `output` stream and
    /// its `isComplete` event (or an idle status flush). Concurrent agents
    /// each get their own slot so multi-agent sessions don't smash a single
    /// buffer. Read for the active-stream card's last-line preview and the
    /// streaming detail view's full text. Empty string for "no active
    /// stream for this agent."
    public private(set) var streamingTextByAgent: [String: String] = [:]
    /// Per-agent model id stamped by the daemon on the most recent streaming
    /// `output` delta. Used so the synthesized event in stop()/idle flush
    /// carries the model that produced the partial text.
    private var streamingModelByAgent: [String: String] = [:]
    /// Set of agents whose `output` stream is in flight (first delta seen,
    /// no `isComplete` yet). Drives the active-stream-card visibility and
    /// the legacy `isStreaming` / `streamingText` shims.
    public private(set) var streamingAgentSet: Set<String> = []
    /// Per-agent active turn id captured at the first delta. The MQTT
    /// subscribe loop reads this on reconnect to replay any envelopes
    /// (incl. the trailing `status_change=idle`) the broker may have
    /// dropped while we were disconnected. Without that replay the
    /// active-stream card hangs until pull-to-refresh.
    private var streamingTurnIDByAgent: [String: String] = [:]
    /// Pending throttled mirror of the reducer's streaming buffers onto
    /// the @Observable fields above. Non-nil while a flush is scheduled;
    /// see `scheduleStreamingMirrorFlush()`.
    private var streamingMirrorFlushTask: Task<Void, Never>?
    /// Agents with an in-flight cancel awaiting the daemon's
    /// `statusChange:.idle` acknowledgment. Membership blocks duplicate
    /// cancels; resolved by the idle event or the ack-timeout fallback.
    public private(set) var interruptPendingAgents: Set<String> = []
    /// Per-agent ack-timeout fallbacks armed by `interruptAgent`. The
    /// daemon normally answers a cancel with `statusChange:.idle` within
    /// a second; when that never arrives (broker drop, runtime wedge,
    /// or an ACP host that ignores session/cancel — opencode does), the
    /// timeout synthesizes the idle locally so the stream still settles
    /// and the partial text still lands. The desktop client has no such
    /// fallback and hangs forever — don't copy that.
    private var interruptTimeoutTasks: [String: Task<Void, Never>] = [:]
    private let interruptAckTimeout: TimeInterval = 8
    /// Backwards-compat shim for callers that haven't migrated to the
    /// per-agent map. True when ANY agent is streaming raw text. Most call
    /// sites should prefer `streamingAgentSet` for correct multi-agent
    /// behavior.
    public var isStreaming: Bool { !streamingAgentSet.isEmpty }
    /// Backwards-compat shim. Returns the streaming text of an arbitrary
    /// active agent — adequate for single-agent sessions; multi-agent UI
    /// must read `streamingTextByAgent[agentID]` directly.
    public var streamingText: String {
        guard let agentID = streamingAgentSet.first else { return "" }
        return streamingTextByAgent[agentID] ?? ""
    }
    public var isDaemonOnline = true

    // MARK: - Phase 4 reducer state
    //
    // `ChatTimelineReducer` is now the source of truth for entry
    // mutations. Inline handlers translate each event arrival into a
    // `TimelineInput`, apply the reducer, mirror the reducer's
    // streaming-buffer state into the VM's @Observable fields, then
    // project entries into the SwiftData-backed `events` array via
    // `TimelineSwiftDataSync.sync`. The view continues to read `events`
    // / `streamingTextByAgent` exactly as before.
    private var timelineState = TimelineState()
    /// User-visible transient error from the most recent send-prompt
    /// attempt. Set by `sendPrompt` when `TeamcluService.sendMessage`
    /// throws; auto-cleared after `errorMessageTTL` seconds. The UI binds
    /// to this for an inline banner so silent publish failures stop being
    /// invisible.
    public var sendErrorMessage: String?
    /// OpenCode `question` tool requests awaiting a human answer. They arrive
    /// as raw ACP control events because the question schema is OpenCode-
    /// specific; the UI renders the first pending request above the composer.
    public private(set) var pendingQuestions: [PendingAcpQuestion] = []
    private var errorClearTask: Task<Void, Never>?
    private let errorMessageTTL: TimeInterval = 5
    public let session: Session?
    private let mqtt: MQTTService
    private let hub: MQTTMessageHub
    private let teamID: String

    /// This install's model MRU (ADR-0007). Consulted only as the last resort
    /// before asking the user — never above `session_participants.model`.
    private let clientModelMRU = ClientModelMRU()
    private let peerId: String
    private let teamcluService: TeamcluService?
    private let connectedAgentsStore: ConnectedAgentsStore?
    private let sessionsRepository: SessionRepository?
    private let messagesRepository: MessagesRepository?
    private let workspacesRepository: (any WorkspaceRepository)?
    /// `nonisolated(unsafe)` so the deinit (which runs in a nonisolated
    /// context) can cancel the MQTT subscription task on VM teardown.
    /// Writes happen only from main-actor methods (`start`, `stop`); the
    /// deinit's read happens after all strong references are gone, so the
    /// data-race waiver here is safe in practice.
    // `nonisolated(unsafe)` (not plain `nonisolated`): this is a mutable stored
    // property on an @Observable type, where plain `nonisolated` is rejected.
    // The deinit read is safe in practice (see the note above).
    nonisolated(unsafe) private var task: Task<Void, Never>?
    /// Actor IDs for which this session-detail view has added an MQTT
    /// runtime-state subscription (beyond what SessionListViewModel manages
    /// for ConnectedAgentsStore agents). Tracked so we can unsubscribe on stop().
    private var sessionAgentSubscribedActorIDs: Set<String> = []

    // MARK: - Chip-bar state
    /// Agent actors currently selected in the chip bar. Empty = no specific
    /// mention; all agents will receive the message (broadcast semantics on
    /// the daemon side). Populated by bootstrapChips / toggleAgentChip.
    public private(set) var agentChipSelection: Set<String> = []
    /// Session + context bound together; both are always set or neither is.
    private var sessionBinding: (session: Session, modelContext: ModelContext)?
    /// Ordered list of agent participants shown in the chip bar. Populated
    /// by bootstrapChips from the session's participant list + runtime states.
    public private(set) var agentChipParticipants: [AgentChipParticipant] = []

    // Expose for child views that need to pass these along
    public var mqttRef: MQTTService { mqtt }
    public var hubRef: MQTTMessageHub { hub }
    public var peerIdRef: String { peerId }
    public var teamIDRef: String { teamID }
    public var currentHumanActorIDRef: String? { teamcluService?.currentHumanActorId }
    /// Route actor id resolved from session/runtime context. Empty when
    /// no daemon mapping is available yet (e.g. ConnectedAgentsStore still
    /// loading and runtime row hasn't received state). Callers that need it
    /// for an MQTT publish should bail when empty.
    public var routeActorIDRef: String { resolveRouteActorID() }

    public var sessionTitle: String {
        if let session, !session.title.isEmpty { return session.title }
        // Worktree leaf as a last resort; `sessions.title` is authoritative and
        // the attachment's copy was only ever a mirror of it (ADR-0004).
        if let att = sessionAttachments.first {
            let wt = att.worktree
            if !wt.isEmpty {
                let last = wt.split(separator: "/").last.map(String.init) ?? wt
                if last != "." { return last }
            }
        }
        return "Session"
    }

    /// Every attachment currently serving this session, newest first.
    private var sessionAttachments: [AgentAttachment] {
        guard let ctx = startModelContext,
              let sessionID = session?.sessionId, !sessionID.isEmpty
        else { return [] }
        let suffix = "::\(sessionID)"
        return (try? ctx.fetch(FetchDescriptor<AgentAttachment>()))?
            .filter { $0.id.hasSuffix(suffix) }
            .sorted(by: { ($0.lastEventTime ?? .distantPast) > ($1.lastEventTime ?? .distantPast) }) ?? []
    }

    public var isActive: Bool { sessionAttachments.contains(where: \.isActive) }
    public var isIdle: Bool { !isActive }

    /// Heartbeat-style "agent is currently doing something" flag. Source
    /// of truth for the chip-bar's stop button and any other UI that
    /// needs the full agent-busy window (thinking + tool_use + output).
    /// Why a separate flag: `runtime?.isActive` is unreliable for
    /// session-based detail views (often nil) and some ACP backends
    /// don't flip Active reliably between turns. `isStreaming` only
    /// covers raw text deltas and misses the thinking + tool_use phases.
    /// This flag flips on any ACP event arrival or sendPrompt, and
    /// clears on `statusChange:.idle` or after 10s of silence.
    public private(set) var isAgentWorking: Bool = false
    private var agentWorkingResetTask: Task<Void, Never>?
    private var inFlightPermissionRequestIDs: Set<String> = []
    /// ACP option lists per pending permission request, captured off the
    /// live `permissionRequest` event (the reducer entry doesn't persist
    /// them — they are only meaningful while the request is pending).
    /// Cleared on grant/deny/resolution.
    public private(set) var permissionOptionsByRequestID: [String: [PermissionOptionItem]] = [:]
    // `nonisolated(unsafe)` required: mutable stored property on an @Observable
    // type, where plain `nonisolated` is rejected by the compiler.
    nonisolated(unsafe) private var spawningPollTask: Task<Void, Never>?
    /// Number of consecutive 2s polls fired while waiting for at least one
    /// agent to leave .spawning / nil-runtimeID state. Reset to 0 whenever
    /// the state settles (no agents need polling). Capped at `maxSpawningPolls`
    /// to avoid burning Supabase reads forever if the daemon dies mid-spawn.
    private var spawningPollCount: Int = 0
    private let maxSpawningPolls: Int = 20
    /// True while a `withObservationTracking` registration for the bound
    /// runtime's `status` / `currentModel` is active. One-shot per fire —
    /// `refreshMemberSheet` re-registers after each onChange.
    private var isObservingRuntimeChanges = false
    public var participantCount: Int { session?.participantCount ?? 0 }
    public var hasLiveAttachment: Bool { !sessionAttachments.isEmpty }

    /// Bucket key for AgentEvent storage: the session id. One daemon agent
    /// serves many sessions, so keying by agent identity would collide their
    /// event histories under one id and leak session N-1's prompts into
    /// session N's view.
    private var eventScopeKey: String {
        session?.sessionId ?? ""
    }

    /// Background sender that drains queued OutboxMessage rows. Injected
    /// by the view layer once it has both the live ModelContainer and a
    /// TeamcluService in scope. nil when this VM was constructed for a
    /// runtime-only legacy path (no session, no Teamclu) where the
    /// outbox isn't applicable.
    public var outboxSender: OutboxSender?

    public init(runtime: AgentAttachment? = nil,
                mqtt: MQTTService,
                hub: MQTTMessageHub,
                teamID: String = "",
                peerId: String,
                session: Session? = nil,
                teamcluService: TeamcluService? = nil,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                sessionsRepository: SessionRepository? = nil,
                messagesRepository: MessagesRepository? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                outboxSender: OutboxSender? = nil) {
        _ = runtime; self.mqtt = mqtt; self.hub = hub; self.teamID = teamID; self.peerId = peerId
        self.session = session; self.teamcluService = teamcluService
        self.connectedAgentsStore = connectedAgentsStore
        self.sessionsRepository = sessionsRepository
        self.messagesRepository = messagesRepository
        self.workspacesRepository = workspacesRepository
        self.outboxSender = outboxSender
    }

    /// The session's default routing actor: its primary agent, or the sole
    /// agent when the session predates `primary_agent_id`. Empty when the
    /// roster has not loaded or the session has several agents and no primary —
    /// callers should treat that as "skip publish, retry later" rather than
    /// guessing, since guessing cross-attributes commands between agents.
    private func resolveRouteActorID() -> String {
        if let primary = session?.primaryAgentId, !primary.isEmpty {
            return primary
        }
        if memberSheetAgents.count == 1, let only = memberSheetAgents.first {
            return only.id
        }
        return ""
    }

    /// Rebuilds `groupedEvents` from `events`. Call after any mutation that
    /// adds, removes, or reorders events, or changes the grouping-relevant
    /// fields on an existing event (eventType, isComplete, toolId).
    private func recomputeGroups() {
        groupedEvents = groupEvents(events)
        // Union the delta-driven `streamingAgentSet` with the computed
        // `streamingAgentIDs` (which also covers `isAgentWorking`) so the
        // active-stream card surfaces as soon as `markAgentWorking()` flips
        // on send — without waiting for the first ACP runtime event to
        // round-trip via MQTT. Before this union the card only appeared
        // once a real delta arrived, which could take seconds on a
        // cold-spawn agent.
        feedItems = buildFeedItems(
            events,
            streamingAgentIDs: streamingAgentSet.union(streamingAgentIDs)
        )
    }

    private func sortEventsForDisplay() {
        events.sort {
            if $0.timestamp != $1.timestamp { return $0.timestamp < $1.timestamp }
            if $0.sequence != $1.sequence { return $0.sequence < $1.sequence }
            return $0.id < $1.id
        }
        rebuildIndexes()
    }

    private func pruneDuplicateRuntimeEvents(modelContext: ModelContext) {
        struct Candidate {
            let index: Int
            let score: Int
        }

        var bestByKey: [String: Candidate] = [:]
        var duplicateIndexes = Set<Int>()

        for (index, event) in events.enumerated() {
            guard event.sequence > 0, event.eventType != "user_prompt" else { continue }
            let key = [
                String(event.sequence),
                event.eventType,
                event.senderActorID ?? "",
                event.toolId ?? "",
                event.text ?? ""
            ].joined(separator: "\u{1f}")
            let score = (event.supabaseMessageId == nil ? 0 : 4)
                + (event.isComplete ? 2 : 0)
                + (event.success == nil ? 0 : 1)

            if let current = bestByKey[key] {
                if score > current.score {
                    duplicateIndexes.insert(current.index)
                    bestByKey[key] = Candidate(index: index, score: score)
                } else {
                    duplicateIndexes.insert(index)
                }
            } else {
                bestByKey[key] = Candidate(index: index, score: score)
            }
        }

        for (index, event) in events.enumerated() {
            guard event.eventType == "output",
                  event.supabaseMessageId == nil,
                  event.turnID == nil,
                  let text = event.text,
                  !text.isEmpty
            else { continue }

            let hasFullPersistedReply = events.contains { other in
                guard other.id != event.id,
                      other.eventType == "output",
                      other.supabaseMessageId != nil,
                      (other.senderActorID ?? "") == (event.senderActorID ?? ""),
                      let fullText = other.text,
                      text.count < fullText.count,
                      fullText.hasPrefix(text),
                      event.timestamp >= other.timestamp
                else { return false }
                return true
            }
            if hasFullPersistedReply {
                duplicateIndexes.insert(index)
            }
        }

        guard !duplicateIndexes.isEmpty else { return }
        for index in duplicateIndexes.sorted(by: >) {
            modelContext.delete(events[index])
            events.remove(at: index)
        }
        try? modelContext.save()
    }

    /// Repairs the narrow artifact produced by the old cross-turn buffer bug:
    /// a synthetic sequence-0 segment starts with the full reply from the
    /// preceding turn, followed by its own text. Sequence 0 is important —
    /// normal daemon completions may legitimately quote earlier messages and
    /// must never be rewritten.
    private func repairStaleStreamingPrefixes(modelContext: ModelContext) {
        var previousCompletedOutput: AgentEvent?
        var changed = false
        for event in events {
            guard event.eventType == "output", event.isComplete else { continue }
            if event.sequence == 0,
               let previous = previousCompletedOutput,
               previous.turnID != event.turnID,
               let currentText = event.text,
               let previousText = previous.text,
               let repaired = Self.removingStaleStreamingPrefix(
                   from: currentText,
                   previousText: previousText
               ) {
                event.text = repaired
                changed = true
            }
            previousCompletedOutput = event
        }
        if changed { try? modelContext.save() }
    }

    static func removingStaleStreamingPrefix(from text: String, previousText: String) -> String? {
        guard !previousText.isEmpty,
              text.count > previousText.count,
              text.hasPrefix(previousText) else { return nil }
        let remainder = text.dropFirst(previousText.count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return remainder.isEmpty ? nil : remainder
    }

    // MARK: - Chip-bar bootstrap + selection

    /// Populate chip participants from the session's participant list and
    /// current runtime states. Call this after the session's participant
    /// rows have been resolved (e.g. from Supabase) and the connected-
    /// agents store has been queried for runtime state.
    ///
    /// Selection heuristic (Q7=c): if exactly one agent participates, pre-
    /// select it so the first send is automatically directed at that agent.
    /// Multi-agent sessions start with empty selection (broadcast mode).
    public func bootstrapChips(
        participants: [SessionParticipant],
        runtimeStates: [String: AgentLifecycleState],
        legacyPrimaryAgentID: String? = nil
    ) {
        var agents = participants.filter { $0.role == "agent" }

        // Compatibility: if the session has no agent participants but a legacy
        // primary_agent_id, synthesize one chip for that agent so the chat is
        // still routable.
        if agents.isEmpty, let primary = legacyPrimaryAgentID, !primary.isEmpty {
            agents = [SessionParticipant(actorID: primary, role: "agent", displayName: nil)]
        }

        self.agentChipParticipants = agents.map {
            AgentChipParticipant(
                id: $0.actorID,
                displayName: $0.displayName ?? String($0.actorID.prefix(8)),
                lifecycleState: runtimeStates[$0.actorID] ?? .spawning
            )
        }

        // Bound session: persistence is the source of truth (already hydrated
        // in `bind`). Leave selection alone — even an empty value is the user's
        // explicit choice.
        guard sessionBinding == nil else { return }

        // Unbound (new session before persistence is wired up): apply the legacy
        // single-agent default.
        self.agentChipSelection = agents.count == 1 ? Set([agents[0].actorID]) : []
    }

    /// Toggle the selected state of one chip. Called from the chip-bar tap handler.
    public func toggleAgentChip(_ agentID: String) {
        if agentChipSelection.contains(agentID) { agentChipSelection.remove(agentID) }
        else { agentChipSelection.insert(agentID) }
        persistAgentChipSelection()
    }

    /// Ensure an agent's chip is lit. Idempotent — never unlights. Used by
    /// the @-mention picker so picking an agent always engages them; the
    /// chip-bar toolbar above the composer remains the surface for turning
    /// agents off.
    public func lightAgentChip(_ agentID: String) {
        agentChipSelection.insert(agentID)
        persistAgentChipSelection()
    }

    /// Agent actor ids whose runtime is currently streaming a reply. Used
    /// by the chip bar to swap the chip's `×` button for a stop button.
    ///
    /// Today the detail view is anchored on either a bound runtime (legacy
    /// runtime-only init, where viewModel.runtime is non-nil) or a session
    /// (multi-agent init, where runtime is nil and the source of truth is
    /// memberSheetAgents). In the session case we currently lack per-agent
    /// streaming state, so when isStreaming is true we attribute it to the
    /// only agent in the session — adequate for single-agent sessions and
    /// gracefully degrades to the chip-bar's existing default-light rule.
    /// True per-agent streaming attribution is a future-work item that
    /// arrives with multi-agent ACP fanout.
    public var streamingAgentIDs: Set<String> {
        // `isAgentWorking` is the canonical busy signal — flips true on
        // any ACP event arrival (thinking, tool_use, output) and clears
        // on idle. `isActive`/`isStreaming` are kept as fallbacks so the
        // stop button stays up even if the heartbeat flag misses an
        // event for any reason.
        guard isAgentWorking || isActive || isStreaming else { return [] }
        // We can't disambiguate among multiple agents from a session-wide busy
        // flag. With exactly one agent, attribute the
        // busy state to it. With more, leave empty (chip stays as ×)
        // until per-agent attribution lands.
        if memberSheetAgents.count == 1, let only = memberSheetAgents.first {
            return [only.id]
        }
        return []
    }

    /// Cancel a specific agent's currently-running ACP turn.
    ///
    /// Deliberately does NOT clear any streaming state here. The daemon
    /// answers the cancel with `statusChange:.idle`, and the reducer's
    /// idle path flushes the partial text into a completed entry for
    /// exactly this bucket — clearing optimistically (the old behavior)
    /// discarded everything the user had watched stream in AND wiped
    /// concurrent agents' live buffers via the global markAgentDone().
    /// An 8s ack-timeout synthesizes the idle locally if the daemon
    /// never responds, so the card can't hang forever either.
    public func interruptAgent(_ agentActorID: String) {
        guard !interruptPendingAgents.contains(agentActorID) else { return }
        interruptPendingAgents.insert(agentActorID)
        Task {
            do {
                try await sendCommand(agentActorID: agentActorID) {
                    $0.command = .cancel(Amux_AcpCancel())
                }
                armInterruptAckTimeout(for: agentActorID)
            } catch {
                // sendCommand already surfaced the user-facing error.
                // Keep the stream live so the user can retry the stop.
                interruptPendingAgents.remove(agentActorID)
            }
        }
    }

    /// Prepend `@<displayName> ` for every lit chip whose token isn't
    /// already in the body. Lets the auto-light single-agent default
    /// produce a self-describing message (e.g. "@mini Top 10 news") even
    /// when the user typed only the prompt body. Manual @-picks are
    /// already inserted by the composer, so the contains() check skips
    /// them to avoid double-prepend.
    func composeBodyWithMentions(_ text: String) -> String {
        var body = text
        for agentID in agentChipSelection {
            guard let agent = memberSheetAgents.first(where: { $0.id == agentID }) else { continue }
            let token = "@\(agent.displayName)"
            if !body.localizedCaseInsensitiveContains(token) {
                body = body.isEmpty ? token : "\(token) \(body)"
            }
        }
        return body
    }

    /// Replace the entire chip selection. Used by Task 16 view integration.
    public func setAgentChipSelection(_ selection: Set<String>) {
        self.agentChipSelection = selection
        persistAgentChipSelection()
    }

    // MARK: - Session binding (chip persistence)

    /// Bind a `Session` model and its `ModelContext` so that chip-bar
    /// mutations are persisted to `session.selectedAgentIds`. Also
    /// hydrates `agentChipSelection` from the stored value.
    /// Call this once when the session and model context are both available.
    public func bind(session: Session, modelContext: ModelContext) {
        self.sessionBinding = (session, modelContext)
        self.agentChipSelection = Set(session.selectedAgentIds)
    }

    private func persistAgentChipSelection() {
        guard let binding = sessionBinding else { return }
        binding.session.selectedAgentIds = Array(agentChipSelection).sorted()
        try? binding.modelContext.save()
    }

    /// Drops any agent IDs from `agentChipSelection` that are no longer
    /// present in `memberSheetAgents` (i.e. ghost selections left over from
    /// a removed agent). Persists the pruned set when any IDs were removed.
    private func pruneGhostAgentSelection() {
        let valid = Set(memberSheetAgents.map(\.id))
        let pruned = agentChipSelection.intersection(valid)
        guard pruned.count != agentChipSelection.count else { return }
        agentChipSelection = pruned
        persistAgentChipSelection()
    }

    // MARK: - Member sheet state
    //
    // Snapshot models (MemberSheetHuman / MemberSheetAgent) and the
    // loader/chipState/displayName helpers live in
    // AMUXCore/Sessions/SessionMemberSheetLoader.swift.

    public private(set) var memberSheetHumans: [MemberSheetHuman] = []
    public private(set) var memberSheetAgents: [MemberSheetAgent] = []

    /// Per-agent latest plan_update parsed into a snapshot, filtered to
    /// agents that still have unfinished items. Empty when no agent in the
    /// session has a live plan. The `SessionDetailView` toolbar icon and
    /// `SessionPlansPanelView` both render off this.
    public var activePlanSnapshots: [AgentPlanSnapshot] {
        AgentPlanSnapshot.derive(
            events: events,
            agentNameFor: { [self] id in self.agentDisplayName(actorID: id) }
        )
    }

    private func agentDisplayName(actorID id: String) -> String {
        memberSheetAgents.first(where: { $0.id == id })?.displayName
            ?? String(id.prefix(8))
    }

    /// Refreshes the member sheet data from Supabase. Called by the view
    /// each time the sheet opens. On failure keeps prior values.
    ///
    /// Loading / shaping logic lives in `SessionMemberSheetLoader`;
    /// this method binds the snapshot to the VM and runs the chip-bar
    /// auto-light cross-cutting rule.
    public func refreshMemberSheet() async {
        guard let session, !session.sessionId.isEmpty else { return }
        let loader = SessionMemberSheetLoader(
            sessionsRepository: sessionsRepository
        )
        // Snapshot every attachment serving this session into a Sendable
        // `actorID -> model ids` map on the MainActor, then hand the loader a
        // @Sendable closure that touches none of `self`.
        //
        // The old version could only answer for the single bound runtime and
        // compared a runtime id against an actor id to do it, so every agent
        // got an empty list and the picker never rendered. Attachments are
        // keyed by (actor, session), which is exactly what is being asked for.
        let modelsByActor = attachmentModelIDsForSession()
        guard let snapshot = await loader.load(
            sessionID: session.sessionId,
            teamID: teamID,
            currentHumanActorID: teamcluService?.currentHumanActorId ?? "",
            availableModelsForAgent: { actorID in modelsByActor[actorID] ?? [] }
        ) else {
            print("[SessionDetailVM] refreshMemberSheet: loader returned nil (no repo or fetch failed)")
            return
        }

        memberSheetHumans = snapshot.humans
        memberSheetAgents = snapshot.agents
        pruneGhostAgentSelection()

        // The participants fetch above knows what the cloud knows: workspace,
        // last chosen model. Whether an agent is running *right now*, and what
        // it can run, only the actor retain knows — overlay it.
        overlayAttachmentState()


        // Reconnect replays that couldn't be routed before this roster
        // loaded (actor_id bucket with no runtime_id mapping) get exactly
        // one retry now that the mapping exists.
        await retryPendingTurnReplays()

        // Ensure MQTT subscriptions exist for every session agent so that
        // retained runtime/state messages (carrying availableModels) are
        // delivered even for agents not in ConnectedAgentsStore.
        subscribeToSessionAgentRuntimeStates()

        // While any agent is still spawning OR has no Supabase runtime row
        // yet (just-spawned, row not written), keep polling so the sheet
        // self-updates once state settles — covers the SwiftData onChange
        // chain missing the MQTT ACTIVE transition for non-bound-runtime views.
        scheduleSpawningRefreshIfNeeded()
    }

    /// Overlays live attachment state (chip state, current model, model
    /// catalog) onto the member-sheet rows the participants fetch produced.
    ///
    /// The participants row owns per-session facts the cloud knows — workspace,
    /// last chosen model. Everything about whether an agent is *running right
    /// now* comes from the actor retain, which the cloud never sees.
    private func overlayAttachmentState() {
        memberSheetAgents = memberSheetAgents.map { agent in
            guard let att = attachment(forAgentActorID: agent.id) else {
                // No attachment: the agent is cold for this session. Absence is
                // the signal, not a lookup failure — leave the row neutral.
                return agent
            }
            let models = att.availableModels.map(\.id)
            return MemberSheetAgent(
                id: agent.id,
                displayName: agent.displayName,
                workspacePath: agent.workspacePath,
                agentType: SessionMemberSheetLoader.displayName(
                    forBackendType: Self.backendType(forAgentTypeRaw: att.agentType)
                ),
                lifecycleState: Self.chipState(forAttachment: att),
                availableModels: models.isEmpty ? agent.availableModels : models,
                // Participant row first: it is the authoritative per-session
                // model (ADR-0005), and the attachment's value is the same fact
                // observed from the runtime. Reversed order let a stale or
                // preference-derived attachment value shadow the truth.
                currentModel: AgentModelResolution.resolve(
                    participantModel: agent.currentModel,
                    liveModel: att.currentModel,
                    mruCandidate: nil
                ).modelID,
                workspaceID: agent.workspaceID,
                backendType: Self.backendType(forAgentTypeRaw: att.agentType)
            )
        }
        pruneGhostAgentSelection()
    }

    /// `Amux_AgentType` raw value → the backend spelling the loader's display
    /// helper expects.
    private static func backendType(forAgentTypeRaw raw: Int) -> String? {
        switch raw {
        case 1: return "claude"
        case 2: return "opencode"
        case 3: return "codex"
        case 4: return "pi"
        case 5: return "cursor"
        default: return nil
        }
    }

    /// Chip state from the attachment. `lifecycle` carries the attach/detach
    /// story and `status` the backend's own idea of busy/idle; lifecycle wins
    /// when it says something definite.
    private static func chipState(forAttachment att: AgentAttachment) -> AgentLifecycleState {
        switch att.status {
        case 1: return .spawning
        case 2: return .active
        case 3: return .idle
        case 4: return .error
        case 5: return .stopped
        default: return .idle
        }
    }

    /// Ensures an actor-state subscription exists for every agent in this
    /// session, not just those in `ConnectedAgentsStore` — that store only
    /// holds agents the current user has explicit access to, so agents a
    /// teammate added would otherwise never deliver their catalog.
    private func subscribeToSessionAgentRuntimeStates() {
        guard !teamID.isEmpty else { return }
        let toSubscribe = Set(memberSheetAgents.map(\.id))
            .filter { !$0.isEmpty && !sessionAgentSubscribedActorIDs.contains($0) }
        guard !toSubscribe.isEmpty else { return }
        let mqtt = self.mqtt
        let teamID = self.teamID
        Task { [weak self] in
            for actorID in toSubscribe {
                try? await mqtt.subscribe(MQTTTopics.actorState(teamID: teamID, actorID: actorID))
            }
            await self?.onExtraRuntimeSubscriptionsAdded()
        }
        sessionAgentSubscribedActorIDs.formUnion(toSubscribe)
    }

    /// Called after extra MQTT subscriptions are set up. Retained messages
    /// arrive within milliseconds; a short yield lets SessionListViewModel
    /// write to SwiftData before we re-overlay.
    @MainActor
    private func onExtraRuntimeSubscriptionsAdded() async {
        try? await Task.sleep(for: .milliseconds(300))
        overlayAttachmentState()
    }

    /// Poll while an agent is still coming up, or is up but has not yet
    /// advertised a catalog — the backend probes models asynchronously after
    /// attach, so an empty list on a live agent means "not yet", not "none".
    private var needsSpawningPoll: Bool {
        memberSheetAgents.contains { agent in
            if agent.lifecycleState == .spawning { return true }
            let isLive = agent.lifecycleState == .active
                || agent.lifecycleState == .idle
                || agent.lifecycleState == .ready
            return isLive && agent.availableModels.isEmpty
        }
    }

    private func scheduleSpawningRefreshIfNeeded() {
        let needsPoll = needsSpawningPoll
        if needsPoll, spawningPollCount < maxSpawningPolls {
            guard spawningPollTask == nil else { return }
            spawningPollCount += 1
            spawningPollTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                self?.spawningPollTask = nil
                await self?.refreshMemberSheet()
            }
        } else {
            spawningPollTask?.cancel()
            spawningPollTask = nil
            if !needsPoll {
                // State settled — reset so the next fresh spawn gets a
                // full budget of polls (covers e.g. addAgent later in the
                // same session view).
                spawningPollCount = 0
            }
        }
    }

    /// The attachment serving this session for the given agent actor, or nil
    /// when that agent is cold. Keyed `(actor, session)` — no runtime id is
    /// involved, and none is obtainable (ADR-0004).
    public func attachment(forAgentActorID actorID: String) -> AgentAttachment? {
        guard let ctx = startModelContext,
              let sessionID = session?.sessionId, !sessionID.isEmpty,
              !actorID.isEmpty
        else { return nil }
        let id = AgentAttachment.makeID(actorID: actorID, sessionID: sessionID)
        let desc = FetchDescriptor<AgentAttachment>(predicate: #Predicate { $0.id == id })
        return (try? ctx.fetch(desc))?.first
    }

    /// `actorID -> available model ids` for every attachment serving this
    /// session. Built on the MainActor so it can be handed to @Sendable code.
    private func attachmentModelIDsForSession() -> [String: [String]] {
        guard let ctx = startModelContext,
              let sessionID = session?.sessionId, !sessionID.isEmpty
        else { return [:] }
        let suffix = "::\(sessionID)"
        let rows = (try? ctx.fetch(FetchDescriptor<AgentAttachment>()))?
            .filter { $0.id.hasSuffix(suffix) } ?? []
        return Dictionary(
            rows.map { ($0.actorID, $0.availableModels.map(\.id)) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    /// Model ids this agent can switch to in this session.
    private func availableModels(forAgentActorID actorID: String) -> [String] {
        attachment(forAgentActorID: actorID)?.availableModels.map(\.id) ?? []
    }

    /// Cheap change-detection key over this session's attachments. SwiftData
    /// mutations don't re-evaluate nested optionals through `@Observable`, so
    /// views observe this scalar instead of reaching into a row.
    public var attachmentStateKey: String {
        guard let ctx = startModelContext,
              let sessionID = session?.sessionId, !sessionID.isEmpty
        else { return "" }
        let suffix = "::\(sessionID)"
        let rows = (try? ctx.fetch(FetchDescriptor<AgentAttachment>()))?
            .filter { $0.id.hasSuffix(suffix) }
            .sorted(by: { $0.id < $1.id }) ?? []
        return rows
            .map { "\($0.id):\($0.lifecycle):\($0.status):\($0.currentModel ?? "")" }
            .joined(separator: "|")
    }

    /// The model the next send will actually run on: the selected agent's, or
    /// the sole agent's when the chip bar has no explicit selection. Nil when
    /// no agent is attached — the session is cold and the daemon picks on spawn.
    public var currentModelForSendTarget: String? {
        resolvedModelForSendTarget?.modelID
    }

    /// The send target's model *and* whether anyone chose it.
    ///
    /// The doc on the old version said a nil answer was fine because "the daemon
    /// picks on spawn". That is precisely the implicit resolution ADR-0007
    /// removes: the daemon's pick came from a device MRU, so the same chat could
    /// answer on a different model depending on where the daemon started. A nil
    /// answer now means **ask the user**, and `requiresExplicitPick` says so.
    public var resolvedModelForSendTarget: AgentModelResolution.Resolved? {
        let targetID: String?
        if let selected = agentChipSelection.first {
            targetID = selected
        } else if memberSheetAgents.count == 1 {
            targetID = memberSheetAgents.first?.id
        } else {
            targetID = nil
        }
        guard let actorID = targetID else { return nil }

        let agentRow = memberSheetAgents.first(where: { $0.id == actorID })
        let att = attachment(forAgentActorID: actorID)
        return AgentModelResolution.resolve(
            participantModel: agentRow?.currentModel,
            liveModel: att?.currentModel,
            // Checked against this agent's live catalog: a remembered model the
            // catalog no longer offers is not a candidate (ClientModelMRU).
            mruCandidate: clientModelMRU.firstAvailable(
                backend: agentRow?.backendType ?? "",
                teamID: teamID,
                available: availableModels(forAgentActorID: actorID)
            )
        )
    }

    /// Union of human + agent actor ids currently in the session, used by
    /// add-member / add-agent sheets to hide rows for participants already in.
    public var existingParticipantActorIDs: Set<String> {
        Set(memberSheetHumans.map(\.id)).union(memberSheetAgents.map(\.id))
    }

    /// Returns the ConnectedAgent rows the caller can pick from when adding a
    /// new agent to the session. Filters out the agents already participating
    /// so the picker shows only fresh candidates. Empty when the store hasn't
    /// loaded yet.
    public func candidatesForAddAgent() -> [ConnectedAgent] {
        let existing = existingParticipantActorIDs
        let agents = connectedAgentsStore?.agents ?? []
        return agents.filter { !existing.contains($0.id) }
    }

    /// Adds humans to the session via `session_participants`, then refreshes
    /// the member sheet so the new rows show up.
    public func addMembers(_ actorIDs: [String]) async {
        guard let session, !actorIDs.isEmpty else { return }
        let sessionID = session.sessionId
        guard !sessionID.isEmpty else { return }

        let sessionsRepo = self.sessionsRepository
        guard let sessionsRepo else {
            print("[SessionDetailVM] addMembers: no sessions repo available")
            return
        }
        do {
            try await sessionsRepo.addParticipants(sessionID: sessionID, actorIDs: actorIDs)
        } catch {
            print("[SessionDetailVM] addMembers: addParticipants failed: \(error)")
            // Fall through — refreshMemberSheet will still re-pull truth.
        }
        await refreshMemberSheet()
    }

    /// Adds an agent to the session and starts a runtime for it on the agent's
    /// daemon. Order matches NewSessionSheet's flow: insert participant first,
    /// then RPC into the daemon to spawn its runtime, then refresh the sheet.
    public func addAgent(actorID: String,
                         workspaceID: String,
                         worktreePath: String,
                         agentType: Amux_AgentType) async {
        guard let session else { return }
        let sessionID = session.sessionId
        guard !sessionID.isEmpty else { return }

        let sessionsRepo = self.sessionsRepository
        if let sessionsRepo {
            do {
                try await sessionsRepo.addParticipants(sessionID: sessionID, actorIDs: [actorID])
            } catch {
                print("[SessionDetailVM] addAgent: addParticipants failed: \(error)")
            }
        } else {
            print("[SessionDetailVM] addAgent: no sessions repo available")
        }

        // Resolve the routing actor id for this agent actor so the
        // runtime-start RPC reaches the right daemon. ConnectedAgentsStore
        // is the authoritative source — same lookup NewSessionSheet uses.
        guard let routeActor = routeActorID(forAgentActorID: actorID), !routeActor.isEmpty else {
            print("[SessionDetailVM] addAgent: no route actor id for agent actor \(actorID)")
            await refreshMemberSheet()
            return
        }

        // Refresh once so the agent row appears (participant row just
        // written), then immediately flip it to .spawning so the sheet
        // shows a spinner for the ~1-3s that the RPC + ACP spawn takes.
        // The attachment has not been published yet at this point, so without
        // the optimistic patch the row would show "default".
        spawningPollCount = 0
        await refreshMemberSheet()
        if let idx = memberSheetAgents.firstIndex(where: { $0.id == actorID }) {
            let cur = memberSheetAgents[idx]
            memberSheetAgents[idx] = MemberSheetAgent(
                id: cur.id, displayName: cur.displayName,
                workspacePath: cur.workspacePath, agentType: cur.agentType,
                lifecycleState: .spawning, availableModels: cur.availableModels,
                currentModel: cur.currentModel,
                workspaceID: cur.workspaceID, backendType: cur.backendType
            )
        }

        if let teamcluService {
            let outcome = await teamcluService.runtimeStartRpc(
                targetActorID: routeActor,
                agentType: agentType,
                workspaceId: workspaceID,
                worktree: worktreePath,
                sessionId: sessionID,
                initialPrompt: ""
            )
            if case .rejected(let reason, _) = outcome {
                print("[SessionDetailVM] addAgent: runtimeStart rejected: \(reason)")
            }
        } else {
            print("[SessionDetailVM] addAgent: no teamcluService configured")
        }

        await refreshMemberSheet()
    }

    /// Removes a human participant from this session.
    ///
    /// Supabase is the source of truth — delete the row first, then refresh
    /// the sheet so the UI reflects the new state. Peer realtime fanout to
    /// other clients is future work (open question: there's no obvious single
    /// daemon to RPC for human-only removal; the daemon's
    /// `handle_remove_participant` only updates its local cache + notify
    /// channel anyway, so for now we rely on each client's own Supabase poll).
    public func removeHuman(_ actorID: String) {
        Task { [weak self] in
            guard let self,
                  let sessionID = self.session?.sessionId,
                  !sessionID.isEmpty else { return }

            let sessionsRepo = self.sessionsRepository
            if let sessionsRepo {
                do {
                    try await sessionsRepo.removeParticipant(sessionID: sessionID, actorID: actorID)
                } catch {
                    print("[SessionDetailVM] removeHuman: removeParticipant failed: \(error)")
                }
            } else {
                print("[SessionDetailVM] removeHuman: no sessions repo available")
            }

            await self.refreshMemberSheet()
        }
    }

    /// Restarts an agent's runtime in the current session: best-effort Stop
    /// of the existing daemon subprocess followed by a fresh Start RPC in the
    /// same workspace + agent type. The daemon publishes a new attachment
    /// row (or updates the existing one — its choice); `refreshMemberSheet`
    /// at the end re-pulls truth so the UI catches up.
    ///
    /// Edge cases:
    ///  - No `routeActorID` (agent's daemon offline): bail with a warning;
    ///    restart isn't possible without a live daemon.
    ///  - No `runtimeID` (runtime never spawned, or already stopped): skip
    ///    the Stop and go straight to Start.
    ///  - Empty / unresolvable worktree path: try Start anyway. The daemon
    ///    rejects with a clean error rather than us pre-validating.
    public func restartAgent(forAgent actorID: String) {
        Task { [weak self] in
            guard let self,
                  let sessionID = self.session?.sessionId,
                  !sessionID.isEmpty,
                  let row = self.memberSheetAgents.first(where: { $0.id == actorID })
            else { return }

            guard let routeActorID = self.routeActorID(forAgentActorID: actorID),
                  !routeActorID.isEmpty
            else {
                print("[SessionDetailVM] restartAgent: no route actor id for agent actor \(actorID); aborting")
                return
            }

            guard let teamcluService = self.teamcluService else {
                print("[SessionDetailVM] restartAgent: no teamcluService configured")
                return
            }

            // 1. Stop existing runtime. Best-effort; if it's already gone the
            //    Start below will still do the right thing.
            if let runtimeID = self.attachmentAddress(forAgentActorID: actorID),
               !runtimeID.isEmpty {
                let (ok, err) = await teamcluService.runtimeStopRpc(
                    targetActorID: routeActorID,
                    runtimeID: runtimeID
                )
                if !ok {
                    print("[SessionDetailVM] restartAgent: runtimeStop failed: \(err) — proceeding to start")
                }
            } else {
                print("[SessionDetailVM] restartAgent: no runtime id for actor \(actorID); skipping stop")
            }

            // 2. Resolve the worktree filesystem path. `MemberSheetAgent`
            //    holds the workspace UUID (not a path) under both
            //    `workspaceID` and the legacy `workspacePath` field, so
            //    look it up against Supabase the same way `AddAgentSheet`
            //    does. Empty path falls through — the daemon rejects with
            //    a clean error.
            let workspaceID = row.workspaceID ?? row.workspacePath
            let worktreePath = await self.resolveWorkspacePath(
                workspaceID: workspaceID,
                agentActorID: actorID
            )

            // 3. Spawn a new runtime in the same workspace + same agent type.
            let agentType = Self.amuxAgentType(forBackendType: row.backendType)
            let outcome = await teamcluService.runtimeStartRpc(
                targetActorID: routeActorID,
                agentType: agentType,
                workspaceId: workspaceID,
                worktree: worktreePath,
                sessionId: sessionID,
                initialPrompt: "",
                resetBackendBinding: true
            )
            if case .rejected(let reason, _) = outcome {
                print("[SessionDetailVM] restartAgent: runtimeStart rejected: \(reason)")
            }

            await self.refreshMemberSheet()
        }
    }

    /// Maps the backend-type spelling to the proto enum
    /// `runtimeStartRpc` expects. Mirrors the AMUXUI-side
    /// `AgentConfigSheet.AgentType.asAmuxAgentType` mapping; we duplicate it
    /// here because that helper lives in the UI package and can't be
    /// imported from AMUXCore.
    private static func amuxAgentType(forBackendType backendType: String?) -> Amux_AgentType {
        switch backendType {
        case "claude": return .claudeCode
        case "opencode": return .opencode
        case "codex": return .codex
        default: return .claudeCode
        }
    }

    /// Best-effort lookup of the worktree filesystem path for a workspace UUID.
    /// Uses the injected Cloud API `WorkspaceRepository`, narrowed to the agent's
    /// own workspaces first (matching `AddAgentSheet`'s default), then widened
    /// to all team workspaces if the agent-scoped query yielded nothing.
    /// Returns "" when the path can't be resolved — the daemon will reject
    /// with a clean error rather than us pre-validating here.
    private func resolveWorkspacePath(workspaceID: String, agentActorID: String) async -> String {
        guard !workspaceID.isEmpty, !teamID.isEmpty else { return "" }
        guard let repo = workspacesRepository else { return "" }

        if let agentScoped = try? await repo.listWorkspaces(teamID: teamID, agentID: agentActorID),
           let hit = agentScoped.first(where: { $0.id == workspaceID }) {
            return hit.path
        }
        if let allScoped = try? await repo.listWorkspaces(teamID: teamID, agentID: nil),
           let hit = allScoped.first(where: { $0.id == workspaceID }) {
            return hit.path
        }
        return ""
    }

    /// The attachment serving this session for `agent`, or nil when that agent
    /// is cold. Used by AgentsSheet to drive the model picker without the sheet
    /// itself holding a SwiftData query or reaching into VM internals.
    public func attachment(for agent: MemberSheetAgent) -> AgentAttachment? {
        attachment(forAgentActorID: agent.id)
    }

    /// Switches the model for an agent's runtime. The daemon's SetModel RPC
    /// updates `current_model_per_agent` and re-publishes the runtime's
    /// retained state, so the member sheet refreshes via the normal state
    /// stream as well — but we still call `refreshMemberSheet` to pick up
    /// any participant-row deltas and to keep parity with the other write
    /// paths (`removeAgent`, `restartAgent`).
    public func setModel(forAgent actorID: String, model: String) {
        Task { [weak self] in
            guard let self,
                  let teamcluService = self.teamcluService,
                  let sessionID = self.session?.sessionId, !sessionID.isEmpty,
                  !actorID.isEmpty
            else {
                print("[SessionDetailVM] setModel: skipping — no session/actor")
                return
            }
            // Address by `{actor}::{session}`. The daemon resolves this to its
            // internal spawn key; that key is never published, so a client
            // cannot address by it (ADR-0004). The agent actor is also the
            // route target — one actor, one daemon.
            let address = AgentAttachment.makeID(actorID: actorID, sessionID: sessionID)
            let routeActor = actorID
            // Apply optimistic update immediately so the UI reflects the choice
            // without waiting for the full RPC + refreshMemberSheet round-trip.
            let previousModel = self.applyOptimisticModelPatch(agentID: actorID, model: model)
            let (ok, err) = await teamcluService.setModelRpc(
                targetActorID: routeActor,
                runtimeID: address,
                modelID: model)
            if !ok {
                print("[SessionDetailVM] setModel RPC failed: \(err)")
                self.rollbackOptimisticModelPatch(agentID: actorID, previousModel: previousModel)
                return
            }
            // refreshMemberSheet re-reads Supabase, which the daemon writes
            // concurrently in a tokio::spawn. Apply the selection optimistically
            // AFTER the refresh so the Supabase race doesn't overwrite the choice.
            await self.refreshMemberSheet()
            if let idx = self.memberSheetAgents.firstIndex(where: { $0.id == actorID }),
               self.memberSheetAgents[idx].currentModel != model {
                let cur = self.memberSheetAgents[idx]
                self.memberSheetAgents[idx] = MemberSheetAgent(
                    id: cur.id, displayName: cur.displayName,
                    workspacePath: cur.workspacePath, agentType: cur.agentType,
                    lifecycleState: cur.lifecycleState, availableModels: cur.availableModels,
                    currentModel: model,
                    workspaceID: cur.workspaceID, backendType: cur.backendType
                )
            }
        }
    }

    @discardableResult
    private func applyOptimisticModelPatch(agentID actorID: String, model: String) -> String? {
        guard let idx = memberSheetAgents.firstIndex(where: { $0.id == actorID }) else { return nil }
        let previous = memberSheetAgents[idx].currentModel
        let cur = memberSheetAgents[idx]
        memberSheetAgents[idx] = MemberSheetAgent(
            id: cur.id, displayName: cur.displayName,
            workspacePath: cur.workspacePath, agentType: cur.agentType,
            lifecycleState: cur.lifecycleState, availableModels: cur.availableModels,
            currentModel: model,
            workspaceID: cur.workspaceID, backendType: cur.backendType
        )
        return previous
    }

    private func rollbackOptimisticModelPatch(agentID actorID: String, previousModel: String?) {
        guard let idx = memberSheetAgents.firstIndex(where: { $0.id == actorID }) else { return }
        let cur = memberSheetAgents[idx]
        memberSheetAgents[idx] = MemberSheetAgent(
            id: cur.id, displayName: cur.displayName,
            workspacePath: cur.workspacePath, agentType: cur.agentType,
            lifecycleState: cur.lifecycleState, availableModels: cur.availableModels,
            currentModel: previousModel,
            workspaceID: cur.workspaceID, backendType: cur.backendType
        )
    }

    /// Removes an agent participant from this session.
    ///
    /// Three-step ordering:
    ///   1. Stop the agent's runtime (best-effort) so the Claude Code
    ///      subprocess actually exits — otherwise it keeps the worktree
    ///      busy and the attachment stays "active"
    ///      until next daemon restart.
    ///   2. RPC the daemon to drop the agent from its in-memory session
    ///      participant cache + sessions.toml, and fan a notify event so
    ///      other connected clients re-pull. Best-effort; the Supabase
    ///      delete below is authoritative.
    ///   3. Delete the participant row from Supabase (source of truth).
    ///
    /// When the agent has no resolvable runtime id (e.g. the daemon is
    /// offline or the attachment hasn't been published yet), step 1
    /// is skipped with a logged warning. The subprocess then keeps running
    /// until the daemon notices the participant is gone on next reload —
    /// suboptimal but recoverable.
    public func removeAgent(_ actorID: String) {
        Task { [weak self] in
            guard let self,
                  let sessionID = self.session?.sessionId,
                  !sessionID.isEmpty else { return }

            let routeActor = self.routeActorID(forAgentActorID: actorID)
            let runtimeID = self.attachmentAddress(forAgentActorID: actorID)

            let purgeWorkspaceID = self.memberSheetAgents
                .first(where: { $0.id == actorID })?
                .workspaceID
                ?? self.memberSheetAgents.first(where: { $0.id == actorID })?.workspacePath
                ?? ""

            // 1. Stop the agent's runtime (best-effort).
            if let routeActor, !routeActor.isEmpty,
               let runtimeID, !runtimeID.isEmpty,
               let teamcluService = self.teamcluService {
                let (ok, err) = await teamcluService.runtimeStopRpc(
                    targetActorID: routeActor,
                    runtimeID: runtimeID,
                    purgeBinding: true,
                    workspaceID: purgeWorkspaceID
                )
                if !ok {
                    print("[SessionDetailVM] removeAgent: runtimeStop failed: \(err)")
                }
            } else {
                print("[SessionDetailVM] removeAgent: skipping runtimeStop — routeActor=\(routeActor ?? "nil") runtimeID=\(runtimeID ?? "nil")")
            }

            // 2. Best-effort daemon-side participant removal for cache
            //    invalidation + peer notify fanout.
            if let routeActor, !routeActor.isEmpty,
               let teamcluService = self.teamcluService {
                let (ok, err) = await teamcluService.removeParticipantRpc(
                    targetActorID: routeActor,
                    sessionID: sessionID,
                    actorID: actorID)
                if !ok {
                    print("[SessionDetailVM] removeAgent: removeParticipantRpc failed: \(err)")
                }
            }

            // 3. Supabase delete (source of truth).
            let sessionsRepo = self.sessionsRepository
            if let sessionsRepo {
                do {
                    try await sessionsRepo.removeParticipant(sessionID: sessionID, actorID: actorID)
                } catch {
                    print("[SessionDetailVM] removeAgent: removeParticipant failed: \(error)")
                }
            } else {
                print("[SessionDetailVM] removeAgent: no sessions repo available")
            }

            await self.refreshMemberSheet()
        }
    }

    /// The routing actor for an agent actor is the agent actor itself: one
    /// daemon serves one agent actor, and it owns the `amux/{team}/{actor}/…`
    /// namespace. This used to be gated on a `ConnectedAgentsStore` membership
    /// check, which returned nil for agents a teammate added to the session —
    /// silently dropping every command aimed at them.
    private func routeActorID(forAgentActorID actorID: String) -> String? {
        actorID.isEmpty ? nil : actorID
    }

    /// The command address for an agent actor in this session:
    /// `{actor}::{session}`. The daemon resolves it to its internal spawn key,
    /// which is never published and therefore cannot be addressed directly.
    private func attachmentAddress(forAgentActorID actorID: String) -> String? {
        guard !actorID.isEmpty,
              let sessionID = session?.sessionId, !sessionID.isEmpty
        else { return nil }
        return AgentAttachment.makeID(actorID: actorID, sessionID: sessionID)
    }

    // MARK: - Index caches (for O(1) event lookup during streaming)
    //
    // Long sessions accumulate thousands of events. Each tool_result /
    // permission_resolved / tool_title_update previously did a
    // `lastIndex(where:)` scan, making the event-handling hot path O(n)
    // and the full session O(n²). These maps + optionals give O(1) lookup;
    // they're maintained incrementally by `appendEvent`/`removeEvent` and
    // rebuilt after bulk operations (fetch, sort, insert-at-zero).
    private var toolUseIndexByToolId: [String: Int] = [:]
    private var permissionIndexByRequestId: [String: Int] = [:]
    private var planUpdateIndexByAgent: [String: Int] = [:]

    private func rebuildIndexes() {
        toolUseIndexByToolId.removeAll(keepingCapacity: true)
        permissionIndexByRequestId.removeAll(keepingCapacity: true)
        planUpdateIndexByAgent.removeAll(keepingCapacity: true)
        for (i, e) in events.enumerated() { registerIndex(event: e, at: i) }
    }

    private func registerIndex(event: AgentEvent, at idx: Int) {
        switch event.eventType {
        case "tool_use":
            if let id = event.toolId { toolUseIndexByToolId[id] = idx }
        case "permission_request":
            if let id = event.toolId { permissionIndexByRequestId[id] = idx }
        case "plan_update":
            planUpdateIndexByAgent[event.agentId] = idx
        default:
            break
        }
    }

    private func appendEvent(_ event: AgentEvent) {
        let idx = events.count
        events.append(event)
        registerIndex(event: event, at: idx)
    }

    private func removeEvent(at idx: Int) {
        let removed = events.remove(at: idx)
        switch removed.eventType {
        case "tool_use":
            if let id = removed.toolId, toolUseIndexByToolId[id] == idx {
                toolUseIndexByToolId.removeValue(forKey: id)
            }
        case "permission_request":
            if let id = removed.toolId, permissionIndexByRequestId[id] == idx {
                permissionIndexByRequestId.removeValue(forKey: id)
            }
        case "plan_update":
            if planUpdateIndexByAgent[removed.agentId] == idx {
                planUpdateIndexByAgent.removeValue(forKey: removed.agentId)
            }
        default: break
        }
        // Shift indexes that pointed past the removed position. k is tiny
        // in practice (one output, one todo, a handful of permissions,
        // tool count per session), so this stays well below the old
        // lastIndex(where:) cost over the whole event stream.
        for (k, v) in toolUseIndexByToolId where v > idx {
            toolUseIndexByToolId[k] = v - 1
        }
        for (k, v) in permissionIndexByRequestId where v > idx {
            permissionIndexByRequestId[k] = v - 1
        }
        for (agent, v) in planUpdateIndexByAgent where v > idx {
            planUpdateIndexByAgent[agent] = v - 1
        }
    }

    /// Validated O(1) lookup. Returns nil (and clears the stale cache
    /// entry) if the cached index no longer matches the predicate, so
    /// callers fall through to their "create new" branch as before.
    private func toolUseIndex(forToolId id: String) -> Int? {
        if let idx = toolUseIndexByToolId[id],
           idx < events.count,
           events[idx].eventType == "tool_use",
           events[idx].toolId == id {
            return idx
        }
        toolUseIndexByToolId.removeValue(forKey: id)
        return nil
    }

    private func permissionIndex(forRequestId id: String) -> Int? {
        if let idx = permissionIndexByRequestId[id],
           idx < events.count,
           events[idx].eventType == "permission_request",
           events[idx].toolId == id {
            return idx
        }
        permissionIndexByRequestId.removeValue(forKey: id)
        return nil
    }

    /// Find an in-flight (incomplete) `output` event belonging to a
    /// specific agent. Used by per-agent streaming output flow so two
    /// concurrent agents don't accidentally claim each other's pending
    /// row when finalizing or replacing a synthetic stop()-saved event.
    private func incompleteOutputIndex(forAgentID agentID: String) -> Int? {
        // Walk newest-first since incomplete outputs cluster near the end.
        var i = events.count - 1
        while i >= 0 {
            let e = events[i]
            if e.eventType == "output",
               e.isComplete == false,
               (e.senderActorID ?? "") == agentID {
                return i
            }
            i -= 1
        }
        return nil
    }

    public func start(modelContext: ModelContext) {
        // Idempotent on re-appear. SwiftUI's NavigationStack fires the
        // source view's `.onAppear` again when a pushed destination
        // pops back; the VM and its MQTT subscription are still alive
        // from the first start(). Cancelling and re-running setup
        // would drop the in-flight `for await msg in stream` loop
        // mid-iteration, so every ACP envelope that arrived while the
        // destination was on top is lost. (Bug visible as
        // StreamingDetailView freezing on the first thinking row
        // until you navigate back, at which point the missed events
        // replay in via incremental sync.)
        if task != nil { return }
        startModelContext = modelContext

        // Bind session persistence for chip-bar selection (idempotent —
        // bind() is a no-op after the first start() returns since `task`
        // guards re-entry above).
        if let s = session {
            bind(session: s, modelContext: modelContext)
        }

        // resolveRuntime may return a placeholder for session-with-pending-
        // primary-agent or nil for collab-only sessions with no agent yet.
        // Either is fine — the cached event load + Supabase seed work off
        // session.sessionId scope, and the streaming subscribe block below
        // gates on `session` not on `runtime`.
        // Seed slash commands from the cached actor retain so the composer
        // popup is populated before (or even without) a fresh
        // AvailableCommandsUpdate arriving on the events stream.
        let cachedCommands = sessionAttachments.first?.availableCommands ?? []
        if !cachedCommands.isEmpty && dynamicAvailableCommands.isEmpty {
            dynamicAvailableCommands = cachedCommands
        }

        // Inbox red-dot clear: local first for instant UI, then the
        // server upsert so other devices' next fetchUnreadFlags() reflects
        // the read. Building the repo on demand avoids plumbing it through
        // every SessionDetailView call site; the SupabaseClient is cheap.
        if let session, session.hasUnread {
            session.hasUnread = false
            try? modelContext.save()
        }
        if let sessionId = session?.sessionId {
            Task.detached {
                guard let config = CloudAPIConfigurationStore.configuration() else { return }
                let storage = KeychainSessionStorage()
                let repo = CloudAPIRepositoryFactory.sessionsRepository(configuration: config) {
                    guard let s = try storage.load(), s.expiresAt.timeIntervalSinceNow > 0 else {
                        throw CloudAPIError.missingAccessToken
                    }
                    return s.accessToken
                }
                try? await repo.markSessionViewed(sessionId: sessionId, lastReadMessageId: nil)
            }
        }

        // Load cached events immediately (works offline). Scope keys on
        // session_id when present so collab-only sessions (no runtime yet)
        // still see past Supabase-seeded messages.
        let scope = eventScopeKey
        let descriptor = FetchDescriptor<AgentEvent>(
            predicate: #Predicate { $0.agentId == scope },
            sortBy: [SortDescriptor(\.timestamp), SortDescriptor(\.sequence)]
        )
        events = (try? modelContext.fetch(descriptor)) ?? []
        pruneDuplicateRuntimeEvents(modelContext: modelContext)
        sortEventsForDisplay()
        repairStaleStreamingPrefixes(modelContext: modelContext)
        // Rehydrate the reducer's state from persisted events so
        // future applies dedup against prior session history.
        rehydrateTimelineStateFromEvents()

        // Insert initial prompt as first user bubble if not already present
        let initialPrompt: String = {
            if let session, !session.summary.isEmpty { return session.summary }
            return ""
        }()

        if !initialPrompt.isEmpty && !events.contains(where: { $0.eventType == "user_prompt" }) {
            let promptEvent = AgentEvent(agentId: scope, sequence: 0, eventType: "user_prompt")
            promptEvent.text = initialPrompt
            // Initial prompt comes from session.summary or runtime.currentPrompt
            // — both written by the session creator at create-time. Stamp the
            // creator so the chat row reads as theirs even before any live
            // messages arrive.
            promptEvent.senderActorID = session?.createdBy
            modelContext.insert(promptEvent)
            events.insert(promptEvent, at: 0)
            // insert-at-zero shifts every cached index; cheaper to rebuild
            rebuildIndexes()
            rehydrateTimelineStateFromEvents()
        }

        recomputeGroups()
        hasLoadedInitialFeed = true
        // Resume streaming state from any stop()-saved incomplete output
        // rows — one per agent that was mid-stream. Handles every agent
        // (multi-agent sessions persist one synthetic row each) and drops
        // the synthetic rows once their bytes are back in the buffers.
        restoreStreamingAgentSetFromIncompleteOutput()

        // Single subscription path: session/{sid}/live. iOS only ever
        // resolves a session-backed detail view — bare-runtime navigation
        // was deleted alongside RuntimeDestinationView. Daemon mirrors this
        // by fanning all agent envelopes (ACP events + HistoryBatch
        // replies) onto the same topic.
        guard let session else {
            print("[SessionDetailVM] no session bound; skipping subscribe")
            return
        }
        let subscribeTopic = MQTTTopics.sessionLive(teamID: teamID, sessionID: session.sessionId)
        let mqtt = self.mqtt
        let hub = self.hub
        task = Task { @MainActor [weak self, mqtt, hub, subscribeTopic, modelContext] in
            // Outer loop: each iteration represents a fresh MQTT connection lifecycle.
            // When the inner stream finishes (e.g. after disconnect clears continuations),
            // we loop back, wait for reconnect, resubscribe, and trigger an incremental
            // sync to fetch any events missed during the gap.
            while !Task.isCancelled {
                // Wait for MQTT to be connected
                while mqtt.connectionState != .connected {
                    try? await Task.sleep(for: .milliseconds(200))
                    if Task.isCancelled { return }
                }

                // Hub-filtered stream: only messages on the bound session's
                // live topic. The subscribe call below tells the broker to
                // deliver them; the predicate is the belt to those suspenders.
                let stream = await hub.messages(topic: subscribeTopic)
                try? await mqtt.subscribe(subscribeTopic)
                print("[SessionDetailVM] subscribed to \(subscribeTopic)")

                // Two-source recovery:
                //   1. Supabase `messages` for past finalized turns —
                //      this is the team-wide truth that survives any
                //      single daemon's history buffer (multi-agent
                //      friendly).
                //   2. Daemon RequestHistory for events the broker may
                //      have dropped on the floor (new session that's
                //      streaming RIGHT NOW between Supabase persistence
                //      and our subscribe; or kill+relaunch mid-turn).
                //      Without this, fresh session detail shows nothing
                //      until the agent finishes a turn.
                // Dedupe: Supabase-seeded events carry a supabaseMessageId
                // and won't be duplicated by re-running the seed; daemon
                // replay uses sequence-based filtering. Some past-turn
                // double-display can happen for sessions that have BOTH
                // Supabase rows AND daemon history; acceptable trade-off
                // until we add cross-source content dedupe.
                await self?.seedFromSupabaseMessages(modelContext: modelContext)
                // Replay daemon-recorded envelopes for any agent the
                // local state still thinks is mid-stream. Catches the
                // case where the broker dropped the trailing
                // `status_change=idle` (or other late envelopes) while
                // we were disconnected — without this the active-stream
                // card hangs until the user pulls-to-refresh.
                await self?.replayStreamingTurnsAfterReconnect(modelContext: modelContext)
                // No cold-start full-sync — Supabase rows are the timeline
                // source of truth for completed turns. Intermediate ACP
                // events (thinking / tool calls / partial outputs) live in
                // the daemon's per-runtime EventHistory and are fetched
                // on-demand by `requestTurnHistory` when the user opens a
                // turn-detail view.

                for await msg in stream {
                    guard let self else { return }
                    guard let live = try? Teamclu_LiveEventEnvelope(serializedBytes: msg.payload)
                    else { continue }

                    if live.eventType == "acp.event",
                       let envelope = try? Amux_Envelope(serializedBytes: live.body) {
                        handleEnvelope(envelope, modelContext: modelContext)
                    } else if live.eventType.hasPrefix("message."),
                              let msgEnv = try? Teamclu_SessionMessageEnvelope(serializedBytes: live.body),
                              msgEnv.hasMessage {
                        // Other collaborators' chat messages — convert to a
                        // user_prompt AgentEvent so EventFeedView renders
                        // them. Loopback / dedupe handled inside.
                        handleIncomingChatMessage(msgEnv.message, modelContext: modelContext)
                    }
                }
                // Stream finished — connection likely dropped. Loop and resubscribe.
                if Task.isCancelled { return }
                print("[SessionDetailVM] stream ended, waiting to resubscribe…")
            }
        }
    }

    /// VM lifetime cleanup. Task closure captures `self` weakly so this
    /// fires once the owning view drops its last reference (e.g., user
    /// navigates back from the session detail to the session list).
    /// Without explicit cancel here, the `while !Task.isCancelled` loop
    /// keeps spinning and the MQTT subscription leaks.
    deinit {
        task?.cancel()
        spawningPollTask?.cancel()
    }

    public func stop() {
        task?.cancel(); task = nil
        spawningPollTask?.cancel(); spawningPollTask = nil
        streamingMirrorFlushTask?.cancel(); streamingMirrorFlushTask = nil
        for (_, t) in interruptTimeoutTasks { t.cancel() }
        interruptTimeoutTasks = [:]
        interruptPendingAgents = []
        // Unsubscribe from the actor-state topics added for session agents that
        // aren't in ConnectedAgentsStore. SessionListViewModel manages its own
        // set; we only clean up the ones we added here.
        if !sessionAgentSubscribedActorIDs.isEmpty {
            let toUnsub = sessionAgentSubscribedActorIDs
            let mqtt = self.mqtt
            let teamID = self.teamID
            Task {
                for actorID in toUnsub {
                    let topic = MQTTTopics.actorState(teamID: teamID, actorID: actorID)
                    try? await mqtt.unsubscribe(topic)
                }
            }
            sessionAgentSubscribedActorIDs.removeAll()
        }

        // Flush every in-progress per-agent streaming buffer to a
        // persisted incomplete event so it's visible when the user returns.
        // Multi-agent: each active stream gets its own synthetic row stamped
        // with the producing agent's actor id.
        // The @Observable mirror lags the reducer by up to one throttle
        // interval — sync it first so the persisted partial carries the
        // full streamed text.
        mirrorReducerStreamingState()
        if !streamingAgentSet.isEmpty, let ctx = startModelContext {
            var seq = (events.last?.sequence ?? 0) + 1
            for agentID in streamingAgentSet {
                guard let text = streamingTextByAgent[agentID], !text.isEmpty else { continue }
                let event = AgentEvent(agentId: eventScopeKey, sequence: seq, eventType: "output")
                event.senderActorID = agentID
                event.text = text
                event.isComplete = false
                event.model = streamingModelByAgent[agentID]
                event.turnID = streamingTurnIDByAgent[agentID]
                ctx.insert(event)
                appendEvent(event)
                seq += 1
            }
            try? ctx.save()
            streamingAgentSet.removeAll()
            streamingTextByAgent.removeAll()
            streamingModelByAgent.removeAll()
            streamingTurnIDByAgent.removeAll()
            recomputeGroups()
        }
        startModelContext = nil
    }

    /// Persistent ids of the snapshot rows written by the most recent
    /// `flushStreamingForBackground()`. Per-agent so the foreground
    /// counterpart can find them without colliding with any other
    /// incomplete-output rows the daemon or `stop()` may have produced.
    private var backgroundSnapshotIDByAgent: [String: String] = [:]

    /// Persist a copy of every in-flight per-agent streaming buffer as
    /// an incomplete `output` row, without cancelling the MQTT task or
    /// mutating the in-memory streaming state. Wire to
    /// `scenePhase == .background`: if iOS reclaims the suspended
    /// process, the next cold launch's `start()` →
    /// `restoreStreamingAgentSetFromIncompleteOutput()` hydrate path picks
    /// the snapshot up and the user sees their partial text instead of an
    /// empty bubble.
    /// `discardBackgroundSnapshot()` removes it again on the common
    /// path where the process survived.
    public func flushStreamingForBackground() {
        // Sync the throttled mirror so the snapshot carries the full
        // streamed text, not a buffer up to one flush interval stale.
        mirrorReducerStreamingState()
        guard !streamingAgentSet.isEmpty,
              let ctx = startModelContext else { return }

        // Drop any prior snapshot first so repeat bg/fg cycles don't
        // accumulate a chain of stale partials.
        discardBackgroundSnapshot()

        var seq = (events.last?.sequence ?? 0) + 1
        for agentID in streamingAgentSet {
            guard let text = streamingTextByAgent[agentID], !text.isEmpty else { continue }
            let event = AgentEvent(agentId: eventScopeKey, sequence: seq, eventType: "output")
            event.senderActorID = agentID
            event.text = text
            event.isComplete = false
            event.model = streamingModelByAgent[agentID]
            event.turnID = streamingTurnIDByAgent[agentID]
            ctx.insert(event)
            // Deliberately NOT appendEvent — keep this row out of
            // `events` so the live UI keeps rendering the single
            // streaming buffer. The row exists only to survive a
            // suspended-process kill.
            backgroundSnapshotIDByAgent[agentID] = event.id
            seq += 1
        }
        try? ctx.save()
    }

    /// Counterpart to `flushStreamingForBackground()`. Deletes the
    /// snapshot rows we wrote on the way out now that the process
    /// has survived and the live `streamingTextByAgent` buffer is
    /// once again the source of truth. Idempotent.
    public func discardBackgroundSnapshot() {
        guard !backgroundSnapshotIDByAgent.isEmpty else { return }
        guard let ctx = startModelContext else {
            backgroundSnapshotIDByAgent.removeAll()
            return
        }
        for id in backgroundSnapshotIDByAgent.values {
            let descriptor = FetchDescriptor<AgentEvent>(
                predicate: #Predicate { $0.id == id }
            )
            if let row = (try? ctx.fetch(descriptor))?.first {
                ctx.delete(row)
            }
        }
        try? ctx.save()
        backgroundSnapshotIDByAgent.removeAll()
    }

    private func handleEnvelope(_ env: Amux_Envelope, modelContext: ModelContext) {
        switch env.payload {
        case .acpEvent(let acp):
            // Bucket by `actor_id`, not `runtime_id`. The latter is the
            // daemon's per-spawn key: minted fresh on every start, published
            // on no topic since ADR-0004, and therefore impossible for a
            // client to map back to an agent. `actor_id` rides the same
            // envelope, is stable across restarts, and is the very value the
            // daemon persists as `sender_actor_id` on agent messages — so
            // live events and seeded history land in the same bucket for free.
            if handleAcpEvent(acp,
                              sequence: Int(env.sequence),
                              runtimeID: env.actorID,
                              turnID: env.turnID.isEmpty ? nil : env.turnID,
                              timestamp: env.timestamp > 0
                                  ? Date(timeIntervalSince1970: TimeInterval(env.timestamp))
                                  : .now,
                              modelContext: modelContext) {
                try? modelContext.save()
                recomputeGroups()
            }
        case .sessionEvent(let evt): handleSessionEvent(evt, sequence: Int(env.sequence), modelContext: modelContext)
        case .none: break
        }
    }

    /// Handles a `message.created` live envelope (chat message from another
    /// collaborator, or a loopback of our own send). For pure-human sessions
    /// this is the only inbound source — there's no daemon fanning ACP
    /// events. We convert the proto message into a `user_prompt` AgentEvent
    /// so EventFeedView renders it the same way as the local user's typed
    /// prompts.
    ///
    /// Loopback dedupe is two-layer: senderActorID match against the local
    /// human actor catches the common case; a content+type fallback covers
    /// older actors that haven't resolved currentHumanActorId yet, and
    /// re-arrivals during reconnect.
    private func handleIncomingChatMessage(_ message: Teamclu_Message, modelContext: ModelContext) {
        // Pre-filters: only render text messages, and drop our own
        // loopbacks + content-equal duplicates before feeding the
        // reducer so its identity-dedup doesn't conflate a fresh
        // message with a re-arrival under a different messageID.
        guard message.kind == .text else { return }
        let myActorID = teamcluService?.currentHumanActorId ?? ""
        if !myActorID.isEmpty, message.senderActorID == myActorID { return }
        let content = message.content
        if events.contains(where: {
            $0.eventType == "user_prompt" && ($0.text ?? "") == content
        }) {
            return
        }

        let dirty = applyTimelineInput(
            .liveMessage(LiveMessageInput(
                messageID: message.messageID.isEmpty ? UUID().uuidString : message.messageID,
                clientLocalID: nil,
                senderActorID: message.senderActorID,
                content: content,
                createdAt: message.createdAt > 0
                    ? Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                    : .now
            )),
            modelContext: modelContext
        )
        if dirty { recomputeGroups() }
    }

    /// Normalises an envelope's `actor_id` into a bucket key. No resolution
    /// step any more: the value on the wire is already the agent actor id.
    private func bucketKey(forActorID runtimeID: String?) -> String? {
        let trimmed = runtimeID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Builds a fresh AgentEvent stamped with the agent that produced it.
    /// `runtimeID` is the envelope's `actor_id` — already the bucket key, and
    /// the same value the daemon persists as `sender_actor_id`, so live events
    /// and seeded history group together with no reconciliation pass. We
    /// deliberately do NOT fall back to `session.primaryAgentId`: concurrent
    /// agents would cross-attribute their early events to whichever agent
    /// happens to be "primary".
    private func makeAgentSideEvent(sequence: Int,
                                    eventType: String,
                                    runtimeID: String? = nil) -> AgentEvent {
        let event = AgentEvent(agentId: eventScopeKey, sequence: sequence, eventType: eventType)
        event.senderActorID = bucketKey(forActorID: runtimeID)
        return event
    }

    /// Applies one ACP event to in-memory + SwiftData state. Returns `true`
    /// iff the event caused a SwiftData mutation or a change to grouping-
    /// relevant fields; callers save + recompute groups only when `true`.
    /// Streaming deltas (the hot path, dozens per second) return `false`
    /// after the first delta of a stream, skipping the SQLite commit and
    /// the O(n) regroup that would otherwise fire on every token.
    @discardableResult
    private func handleAcpEvent(_ acp: Amux_AcpEvent,
                                sequence: Int,
                                runtimeID: String? = nil,
                                turnID: String? = nil,
                                timestamp: Date = .now,
                                isHistoryReplay: Bool = false,
                                modelContext: ModelContext) -> Bool {
        // Heartbeat: any live ACP event arrival means the runtime is busy.
        // Skip for history-replay batches (requestTurnHistory responses) —
        // those events belong to an already-completed turn and must not
        // flip the agent chip to "running".
        // Also skip for statusChange: a runtime transitioning to "active"
        // (daemon spawn ready) does not mean the agent is processing a user
        // prompt. Only thinking / tool_use / output events indicate real work.
        if !isHistoryReplay, case .statusChange(_) = acp.event {
            // lifecycle event — don't mark working
        } else if !isHistoryReplay {
            markAgentWorking()
        }

        // Replayed streaming deltas must not reach the reducer: they would
        // re-open the live buffer (streamingAgentSet + text), and the
        // closing idle envelope is sequence-deduped away (the live flush
        // entry already claimed its sequence) — the buffer never closed
        // and the "agent working" card resurrected after visiting the
        // turn-detail view. The finalized text is already in the timeline;
        // deltas add nothing on replay.
        if isHistoryReplay, case .output(let o) = acp.event, !o.isComplete {
            return false
        }

        // Capture the ACP option list off a live permission request.
        // Options are ephemeral UI state — history replay repopulates
        // them, and a banner with no entry falls back to the OpenCode
        // defaults. When the session is in full-access mode, answer the
        // request on the user's behalf (allow-once) instead of waiting
        // on a tap — mirrors the desktop's per-session permission mode,
        // including its limitation: the answer comes from the client, so
        // it only fires while this session's detail VM is live in the
        // foreground. A backgrounded phone cannot answer; unattended
        // full-access needs a daemon-side mode, not this toggle.
        if case .permissionRequest(let pr) = acp.event {
            if !pr.options.isEmpty {
                permissionOptionsByRequestID[pr.requestID] = pr.options.map {
                    PermissionOptionItem(id: $0.optionID, kind: $0.kind, name: $0.name)
                }
            }
            if !isHistoryReplay, session?.autoApprovePermissions == true,
               // No once-scoped allow on offer (e.g. only allow_always) →
               // leave the banner for a human; auto-flipping the agent's
               // permanent permission state is never this toggle's call.
               let option = PermissionOptionItem.allowOnceOption(from: permissionOptions(for: pr.requestID)) {
                let requestID = pr.requestID
                let sender = bucketKey(forActorID: runtimeID)
                Task { [weak self] in
                    try? await self?.grantPermission(
                        requestId: requestID,
                        agentActorID: sender,
                        optionID: option.id
                    )
                }
            }
        }

        // Reducer is source of truth for entry mutations. Apply +
        // project. Side effects the reducer doesn't track (runtime
        // status flip, heartbeat reset) are handled below.
        let bucket = bucketKey(forActorID: runtimeID) ?? eventScopeKey
        let dirty = applyTimelineInput(
            .acp(AcpInput(
                envelopeSequence: UInt64(sequence),
                agentBucketKey: bucket,
                // The envelope's original publish time, NOT .now: replayed
                // history stamped with the replay moment used to sort past
                // the turn's close — resolved permission cards sank to the
                // bottom of the feed and replayed runtime events re-opened
                // the turn (phantom "agent working" card).
                timestamp: timestamp,
                turnID: turnID,
                acpEvent: acp
            )),
            modelContext: modelContext
        )

        // Heartbeat side effects. Idle settles ONLY this
        // bucket — the reducer just flushed its partial text and cleared
        // its streaming slots; concurrent agents' live buffers stay
        // untouched (the old global markAgentDone() wiped them, losing
        // their streamed text mid-turn).
        if case .statusChange(let sc) = acp.event, sc.newStatus == .idle {
            // Status itself is owned by the actor retain — writing it locally
            // would be overwritten on the next publish and lie until then.
            // Only the turn-settling side effect belongs here.
            settleAgentTurn(bucket: bucket)
        }

        // Some runtimes finish a turn with output{isComplete:true} but omit
        // the final statusChange:.idle. Do not leave the optimistic
        // "Agent loading" card up for the 60-second safety window. A short
        // delayed settle gives an immediately-following tool event time to
        // cancel this task via markAgentWorking(), while still closing a
        // genuinely completed turn promptly.
        if !isHistoryReplay,
           case .output(let output) = acp.event,
           output.isComplete {
            armCompletedOutputSettle(bucket: bucket)
        }

        // Raw OpenCode question events are control-plane state, not timeline
        // rows. Keep them in-memory and let the composer surface the prompt.
        if case .raw(let raw) = acp.event,
           raw.method == "question_asked",
           let question = Self.decodePendingQuestion(raw.jsonPayload, agentActorID: bucket) {
            if let index = pendingQuestions.firstIndex(where: { $0.id == question.id }) {
                pendingQuestions[index] = question
            } else {
                pendingQuestions.append(question)
            }
        } else if case .raw(let raw) = acp.event,
                  raw.method == "question_replied" || raw.method == "question_rejected",
                  let requestID = Self.questionRequestID(raw.jsonPayload) {
            pendingQuestions.removeAll { $0.id == requestID }
        }

        // Hand-rolled raw tool_title_update parser. The reducer
        // explicitly leaves `.raw` alone (see TimelineInput.swift
        // contract); patch the matching tool_use entry in place.
        if case .raw(let raw) = acp.event, raw.method == "tool_title_update" {
            let payload = String(data: raw.jsonPayload, encoding: .utf8) ?? ""
            if let pipeIdx = payload.firstIndex(of: "|") {
                let toolId = String(payload[payload.startIndex..<pipeIdx])
                let newTitle = String(payload[payload.index(after: pipeIdx)...])
                if let idx = events.firstIndex(where: { $0.eventType == "tool_use" && $0.toolId == toolId }) {
                    events[idx].toolName = newTitle
                    try? modelContext.save()
                    return true
                }
            }
        }

        return dirty
    }

    static func decodePendingQuestion(_ data: Data, agentActorID: String) -> PendingAcpQuestion? {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestID = payload["id"] as? String,
              !requestID.isEmpty,
              let rawQuestions = payload["questions"] as? [[String: Any]]
        else { return nil }

        let questions = rawQuestions.enumerated().compactMap { index, raw -> AcpQuestionPrompt? in
            let text = raw["question"] as? String ?? ""
            guard !text.isEmpty else { return nil }
            let options: [AcpQuestionOption] = (raw["options"] as? [Any] ?? []).compactMap { value in
                if let label = value as? String, !label.isEmpty {
                    return AcpQuestionOption(label: label, description: "")
                }
                guard let option = value as? [String: Any],
                      let label = option["label"] as? String,
                      !label.isEmpty else { return nil }
                return AcpQuestionOption(
                    label: label,
                    description: option["description"] as? String ?? ""
                )
            }
            return AcpQuestionPrompt(
                id: String(index),
                header: raw["header"] as? String ?? String(localized: "Question"),
                question: text,
                options: options,
                allowsMultiple: raw["multiple"] as? Bool ?? false
            )
        }
        guard !questions.isEmpty else { return nil }
        return PendingAcpQuestion(id: requestID, agentActorID: agentActorID, questions: questions)
    }

    private static func questionRequestID(_ data: Data) -> String? {
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return (payload["requestID"] as? String) ?? (payload["id"] as? String)
    }

    private func handleSessionEvent(_ sessionEvent: Amux_SessionEvent, sequence: Int, modelContext: ModelContext) {
        switch sessionEvent.event {
        case .promptAccepted:
            // The typing indicator rides on `isAgentWorking`, which the ACP
            // event stream already drives; attachment status comes from the
            // retain and is not ours to write.
            break
        case .promptRejected(let pr):
            let event = makeAgentSideEvent(sequence: sequence, eventType: "error")
            event.text = String(localized: "Rejected: \(pr.reason)")
            appendEvent(event)
            recomputeGroups()
        case .permissionResolved(let resolved):
            // Someone answered (this device or another collaborator) —
            // the option list is dead weight now.
            permissionOptionsByRequestID[resolved.requestID] = nil
            // Reducer updates the matching permission_request entry
            // in place; sync mirrors the mutation onto the SwiftData
            // row. Drops silently if there's no matching entry, same
            // as the prior inline behaviour.
            let dirty = applyTimelineInput(
                .permissionResolution(PermissionResolutionInput(
                    requestID: resolved.requestID,
                    granted: resolved.granted
                )),
                modelContext: modelContext
            )
            if dirty { recomputeGroups() }
        case .historyBatch(let batch):
            handleHistoryBatch(batch)
        case .none:
            break
        }
    }

    private var syncModelContext: ModelContext?
    public var isSyncing = false
    private var syncGeneration: Int = 0
    private var startModelContext: ModelContext?

    /// A completed output is also the stream-closing signal. History replay
    /// must pass it through the reducer even when its sequence is already in
    /// SwiftData: earlier missing deltas in the same batch may have just
    /// reopened the in-memory stream. The reducer's turn-id merge keeps the
    /// persisted completion idempotent while clearing that transient state.
    nonisolated static func shouldApplyHistoryEnvelope(
        _ envelope: Amux_Envelope,
        existingSequences: Set<Int>
    ) -> Bool {
        let sequence = Int(envelope.sequence)
        guard existingSequences.contains(sequence) else { return true }
        guard case .acpEvent(let acp) = envelope.payload,
              case .output(let output) = acp.event
        else { return false }
        return output.isComplete
    }

    private func handleHistoryBatch(_ batch: Amux_HistoryBatch) {
        guard let modelContext = syncModelContext else { return }
        let existingSeqs = Set(events.compactMap { $0.sequence != 0 ? $0.sequence : nil })

        // Aggregate dirty across the batch so we save + regroup once per page
        // instead of per-event. Sort+regroup is deferred to the last page in
        // the common case where the client keeps paginating (batch.hasMore_p).
        var anyDirty = false
        for envelope in batch.events {
            let seq = Int(envelope.sequence)
            guard Self.shouldApplyHistoryEnvelope(
                envelope,
                existingSequences: existingSeqs
            ) else { continue }

            if case .acpEvent(let acp) = envelope.payload {
                if handleAcpEvent(acp,
                                  sequence: seq,
                                  // Bucket by actor_id like the live path
                                  // (ADR-0004) — the per-spawn runtime id
                                  // matches no agent, so replayed events
                                  // used to land in a ghost bucket whose
                                  // turn never closed (phantom "agent
                                  // working" card after visiting 过程).
                                  runtimeID: envelope.actorID.isEmpty
                                      ? envelope.runtimeID
                                      : envelope.actorID,
                                  turnID: envelope.turnID.isEmpty ? nil : envelope.turnID,
                                  timestamp: envelope.timestamp > 0
                                      ? Date(timeIntervalSince1970: TimeInterval(envelope.timestamp))
                                      : .now,
                                  isHistoryReplay: true,
                                  modelContext: modelContext) {
                    anyDirty = true
                }
            }
        }

        if anyDirty {
            try? modelContext.save()
        }

        // Turn-history responses arrive as a single batch — the daemon
        // sets has_more=true only when the trim-to-budget loop dropped
        // events. We don't paginate (no cursor for turn-scope queries)
        // so the local streaming cache + live MQTT deltas fill the gap
        // for huge turns. Always finalize after one batch.
        sortEventsForDisplay()
        recomputeGroups()
        syncGeneration &+= 1
        isSyncing = false
    }

    /// Fetch events newer than our local max sequence from the daemon.
    /// Cursor-based + paginated — cheap to call on every reconnect / foreground.
    ///
    /// Pull `messages` rows for this session from Supabase and project them
    /// into AgentEvent rows so past completed turns are visible without
    /// hitting the daemon's per-runtime history buffer. Dedupe is keyed on
    /// `supabaseMessageId` — re-running the seed is a no-op once the rows
    /// have been ingested. Tool calls / thinking / status events are NOT
    /// represented; only `user_*` and `agent_reply` kinds become AgentEvents.
    public func seedFromSupabaseMessages(modelContext: ModelContext) async {
        guard let session else { return }
        guard let repo = messagesRepository else { return }
        let messages: [MessageRecord]
        do {
            messages = try await repo.listForSession(sessionID: session.sessionId)
        } catch {
            print("[SessionDetailVM] supabase messages seed failed: \(error)")
            return
        }
        guard !messages.isEmpty else { return }

        // Reducer dedupes by `supabaseMessageID` and backfills the
        // id onto an existing content-equal entry when one exists.
        // Apply per record, project once at the end.
        var anyChange = false
        for record in messages {
            let kind: HistoryKind
            switch record.kind {
            case "agent_reply": kind = .output
            // "text" is the legacy iOS write spelling — kept here so
            // rows that landed in Supabase before the writer switched
            // to "user_message" still rehydrate. Drop once those rows
            // age out.
            case "user_message", "user_prompt", "text": kind = .userPrompt
            default: continue
            }
            let dirty = applyTimelineInput(
                .historyMessage(HistoryInput(
                    supabaseMessageID: record.id,
                    kind: kind,
                    senderActorID: record.senderActorID.isEmpty ? nil : record.senderActorID,
                    content: record.content,
                    createdAt: record.createdAt,
                    model: record.model,
                    turnID: record.turnID,
                    sequence: record.sequence
                )),
                modelContext: modelContext
            )
            if dirty { anyChange = true }
        }
        if anyChange { recomputeGroups() }
    }

    /// On MQTT reconnect, replay the daemon's recorded envelopes for
    /// any agent whose stream the broker may have left mid-turn. The
    /// reducer's `.statusChange=idle` (and any thinking/tool envelopes
    /// the broker dropped) flow back through the same code path that
    /// originally clears `streamingAgentSet`, so the active-stream
    /// card converges to the post-turn state without waiting for a
    /// user pull-to-refresh. Idempotent: existing entries dedupe by
    /// turnID / sequence in `applyAcp`.
    private func replayStreamingTurnsAfterReconnect(modelContext: ModelContext) async {
        let snapshot = streamingTurnIDByAgent
        guard !snapshot.isEmpty else { return }
        for (bucket, turnID) in snapshot {
            guard !turnID.isEmpty else { continue }
            // `bucket` is the actor id post-resolve; the daemon's
            // RequestTurnHistory wants a runtime id. Map actor → runtime
            // via the member sheet. When the mapping isn't available yet,
            // do NOT send the bucket verbatim — the daemon answers an
            // unknown runtime id with nothing and the active-stream card
            // hangs forever. Park the bucket instead and retry once after
            // `refreshMemberSheet` lands the roster.
            guard let runtimeID = turnReplayAddress(forBucket: bucket), !runtimeID.isEmpty else {
                pendingTurnReplayBuckets.insert(bucket)
                print("[SessionDetailVM] replay deferred for \(bucket)/\(turnID): runtime id not resolvable yet")
                continue
            }
            pendingTurnReplayBuckets.remove(bucket)
            do {
                try await self.requestTurnHistory(
                    modelContext: modelContext,
                    turnID: turnID,
                    agentID: runtimeID
                )
            } catch {
                print("[SessionDetailVM] replay turn history failed for \(bucket)/\(turnID): \(error)")
            }
        }
    }

    /// Buckets whose mid-stream turn replay couldn't be routed yet because
    /// the actor_id → runtime_id mapping wasn't loaded. Retried once after
    /// `refreshMemberSheet` completes (see `retryPendingTurnReplays`).
    private var pendingTurnReplayBuckets: Set<String> = []

    /// The command address for replaying `bucket`'s in-flight turn. Buckets
    /// are agent actor ids — events carry `Envelope.actor_id` — so this is a
    /// pure derivation. Nil only before the session id is known, which is the
    /// one case where deferring is still correct.
    private func turnReplayAddress(forBucket bucket: String) -> String? {
        attachmentAddress(forAgentActorID: bucket)
    }

    /// One-shot retry for replays parked by
    /// `replayStreamingTurnsAfterReconnect`. Runs after `refreshMemberSheet`
    /// lands the roster — post-relabel, so parked bucket keys have already
    /// been rewritten raw runtime id → actor id where applicable. Buckets
    /// that still don't resolve keep the prior state (no send) but log;
    /// each parked bucket gets exactly one retry so we never replay-loop.
    private func retryPendingTurnReplays() async {
        guard !pendingTurnReplayBuckets.isEmpty else { return }
        let parked = pendingTurnReplayBuckets
        pendingTurnReplayBuckets = []
        guard let ctx = startModelContext else { return }
        for bucket in parked {
            // The stream may have settled (idle / interrupt) while we
            // waited for the roster — nothing left to replay then.
            guard streamingAgentSet.contains(bucket),
                  let turnID = streamingTurnIDByAgent[bucket], !turnID.isEmpty else { continue }
            guard let runtimeID = turnReplayAddress(forBucket: bucket), !runtimeID.isEmpty else {
                print("[SessionDetailVM] replay retry for \(bucket)/\(turnID) still unroutable; giving up")
                continue
            }
            do {
                try await requestTurnHistory(modelContext: ctx, turnID: turnID, agentID: runtimeID)
            } catch {
                print("[SessionDetailVM] replay retry failed for \(bucket)/\(turnID): \(error)")
            }
        }
    }

    /// Fetch every envelope the daemon has for a specific turn from a
    /// specific runtime's EventHistory log. Used by `StreamingDetailView`
    /// (turn-detail drill-down from the bubble's top-right entry) to show
    /// thinking / tool calls / partial outputs the session timeline
    /// intentionally omits. Repeat calls are cheap — daemon scans the
    /// runtime's index in memory and reducer dedupe handles overlap.
    ///
    /// `agentID` defaults to the current runtime; pass an explicit value
    /// when the turn was produced by a different runtime in the same
    /// session (multi-runtime fanouts).
    public func requestTurnHistory(modelContext: ModelContext,
                                   turnID: String,
                                   agentID: String? = nil) async throws {
        guard !turnID.isEmpty else { return }
        self.syncModelContext = modelContext
        isSyncing = true

        // Watchdog — if the daemon never replies, `isSyncing` must reset
        // so a follow-up tap can re-issue cleanly. Same generation-token
        // trick the old sequence-based sync used.
        syncGeneration &+= 1
        let myGeneration = syncGeneration
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self else { return }
            if self.syncGeneration == myGeneration && self.isSyncing {
                self.isSyncing = false
            }
        }

        // The bubble passes an actor id (route.agentID). Resolve it to
        // the owning runtime + route actor id via the same helper sendCommand
        // uses so the MQTT topic matches the daemon's subscription.
        let route = commandRoute(forAgentActorID: agentID)
        guard !route.address.isEmpty else { return }

        var req = Amux_AcpRequestTurnHistory()
        req.turnID = turnID
        req.requestID = UUID().uuidString

        guard let teamcluService, let sessionID = session?.sessionId, !sessionID.isEmpty else {
            isSyncing = false
            throw SendCommandError.rpcUnavailable
        }
        var command = Amux_AcpCommand()
        command.command = .requestTurnHistory(req)
        let (dispatched, rpcError) = await teamcluService.runtimeCommandRpc(
            targetActorID: route.actorID,
            sessionID: sessionID,
            address: route.address,
            command: command
        )
        if let rpcError {
            isSyncing = false
            throw SendCommandError.rejected(rpcError)
        }
        if !dispatched {
            // Cold session — no attachment, so no history will ever arrive.
            // Reset the sync spinner now instead of waiting out the watchdog.
            isSyncing = false
        }
    }

    private func sendCommand(agentActorID: String? = nil,
                             makeCommand: (inout Amux_AcpCommand) -> Void) async throws {
        let route = commandRoute(forAgentActorID: agentActorID)
        guard !route.address.isEmpty else {
            let key = agentActorID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let error: SendCommandError = key.isEmpty ? .noAgent : .addressEmpty
            surfaceSendError(error)
            throw error
        }
        guard let teamcluService, let sessionID = session?.sessionId, !sessionID.isEmpty else {
            let error = SendCommandError.rpcUnavailable
            surfaceSendError(error)
            throw error
        }
        var command = Amux_AcpCommand()
        makeCommand(&command)
        // ADR-0003: session-addressed dispatch with a delivery receipt — no
        // silent legacy-topic fallback. The daemon answers every command, so
        // a drop is a surfaced error here, never a spinner that waits on a
        // state change that will never come.
        let (dispatched, rpcError) = await teamcluService.runtimeCommandRpc(
            targetActorID: route.actorID,
            sessionID: sessionID,
            address: route.address,
            command: command
        )
        if let rpcError {
            let failure = SendCommandError.rejected(rpcError)
            surfaceSendError(failure)
            throw failure
        }
        if !dispatched {
            let failure = SendCommandError.sessionCold
            surfaceSendError(failure)
            throw failure
        }
    }

    /// Where to send a command for an agent: the topic actor, and the address
    /// the daemon resolves. Both derive from (agent actor, session) — the
    /// former chain of fallbacks existed only because the runtime id had to be
    /// discovered from a store, a retain, or a stale row.
    private func commandRoute(forAgentActorID agentActorID: String?) -> (address: String, actorID: String) {
        let key = agentActorID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let target = key.isEmpty ? resolveRouteActorID() : key
        guard !target.isEmpty, let address = attachmentAddress(forAgentActorID: target) else {
            return ("", "")
        }
        return (address, target)
    }

    public func sendPrompt(_ text: String, modelId: String? = nil, attachmentURLs: [URL] = [], modelContext: ModelContext? = nil) async throws {
        if let session, let teamcluService {
            // Session-backed chats use the session live stream as the
            // canonical messaging channel so other collaborators see the
            // user's prompt too. The daemon subscribes to session/{sid}/live
            // and forwards each message to its bound ACP runtime.
            //
            // Body composition: prepend `@<displayName> ` for any lit chip
            // that the user hasn't already typed inline. The auto-light
            // single-agent default would otherwise produce a body without
            // any visible mention even though the chip is engaging an
            // agent — confusing in chat history, especially for other
            // collaborators reading along.
            let body = composeBodyWithMentions(text)
            let messageID = UUID().uuidString
            let mentionIDs = Array(agentChipSelection)
            AnalyticsSink.track("message_sent", [
                "agentCount": String(mentionIDs.count),
                "hasAttachments": String(!attachmentURLs.isEmpty),
            ])

            // 1. Local user_prompt entry for the bubble. The
            //    reducer's .localPrompt path stamps `outboxMessageID =
            //    clientID` onto the entry so the chat view's
            //    status-dot accessory binds correctly. Apply +
            //    project; the sync layer inserts the matching
            //    AgentEvent row.
            if let ctx = modelContext ?? startModelContext {
                let dirty = applyTimelineInput(
                    .localPrompt(LocalPromptInput(
                        clientID: messageID,
                        senderActorID: teamcluService.currentHumanActorId ?? "",
                        content: body,
                        createdAt: .now
                    )),
                    modelContext: ctx
                )
                if dirty { recomputeGroups() }
            }

            // Flip the busy flag immediately on send so the chip-bar
            // stop button surfaces without waiting for the first ACP
            // event to round-trip. The 10s safety reset still fires;
            // the first real ACP event resets the timer.
            markAgentWorking()

            // 2. Hand the body off to the outbox. The sender loop will
            //    drive MQTT publish + Supabase persist with retries.
            //    Falls back to the legacy synchronous path when the
            //    outbox sender hasn't been wired in (e.g. tests).
            if let outboxSender {
                await outboxSender.enqueue(
                    messageID: messageID,
                    sessionID: session.sessionId,
                    senderActorID: teamcluService.currentHumanActorId ?? "",
                    content: body,
                    mentionActorIDs: mentionIDs,
                    modelID: modelId,
                    attachmentURLs: attachmentURLs
                )
                return
            }

            // Legacy (test/no-outbox) fallback: send synchronously and
            // surface the error inline. Production view-paths always
            // construct an OutboxSender so this branch is exercised
            // primarily by unit tests / earlier-API callers.
            do {
                _ = try await teamcluService.sendMessage(
                    sessionId: session.sessionId,
                    content: body,
                    modelId: modelId,
                    mentionActorIDs: mentionIDs,
                    attachmentURLs: attachmentURLs,
                    messageID: messageID
                )
            } catch {
                surfaceSendError(error)
                throw error
            }
        }
    }
    @MainActor
    private func surfaceSendError(_ error: Error) {
        sendErrorMessage = error.localizedDescription
        errorClearTask?.cancel()
        errorClearTask = Task { [weak self, errorMessageTTL] in
            try? await Task.sleep(for: .seconds(errorMessageTTL))
            guard let self, !Task.isCancelled else { return }
            self.sendErrorMessage = nil
        }
    }

    public func cancelTask() async throws {
        try await sendCommand { $0.command = .cancel(Amux_AcpCancel()) }
        // Same wait-for-idle semantics as interruptAgent: the bound
        // runtime's bucket settles when the daemon acknowledges, with
        // the timeout as backstop. No optimistic global clear.
        let bucket = resolveRouteActorID()
        if !bucket.isEmpty {
            interruptPendingAgents.insert(bucket)
            armInterruptAckTimeout(for: bucket)
        }
    }

    // MARK: - Edit / delete own persisted messages
    //
    // Remote-first on purpose: FC's PATCH/DELETE is the authority (it
    // enforces sender-only semantics), so the local bubble only changes
    // after the server accepted the mutation — a failed call leaves the
    // feed untouched and surfaces through the same inline error banner
    // as a failed send. Only events that carry a `supabaseMessageId`
    // qualify, which the UI guarantees before offering the actions.

    /// Rewrites the content of one of the current user's persisted
    /// prompts, remote then local.
    public func editUserMessage(supabaseMessageID: String, newContent: String) async {
        guard let repo = messagesRepository else { return }
        let content = newContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        do {
            try await repo.patch(messageID: supabaseMessageID, content: content)
        } catch {
            surfaceSendError(error)
            return
        }
        guard let ctx = startModelContext ?? syncModelContext else { return }
        for idx in timelineState.entries.indices
        where timelineState.entries[idx].supabaseMessageID == supabaseMessageID {
            timelineState.entries[idx].text = content
        }
        projectTimelineStateMutation(modelContext: ctx)
        updateSessionMessageCache(messageID: supabaseMessageID, content: content, modelContext: ctx)
    }

    /// Permanently removes one of the current user's persisted prompts,
    /// remote then local.
    public func deleteUserMessage(supabaseMessageID: String) async {
        guard let repo = messagesRepository else { return }
        do {
            try await repo.delete(messageID: supabaseMessageID)
        } catch {
            surfaceSendError(error)
            return
        }
        guard let ctx = startModelContext ?? syncModelContext else { return }
        // Dropping the entry from reducer state is enough — the sync layer
        // deletes any AgentEvent row whose id fell out of state.entries,
        // so there is no separate SwiftData bookkeeping to keep in step.
        timelineState.entries.removeAll { $0.supabaseMessageID == supabaseMessageID }
        projectTimelineStateMutation(modelContext: ctx)
        updateSessionMessageCache(messageID: supabaseMessageID, content: nil, modelContext: ctx)
    }

    /// Shared tail for the direct `timelineState.entries` mutations above.
    /// They bypass the reducer (there is no TimelineInput for "the user
    /// rewrote history"), so the projection + recompute that
    /// `applyTimelineInput`'s `.entriesChanged` arm performs has to be
    /// invoked manually here.
    private func projectTimelineStateMutation(modelContext: ModelContext) {
        let dirty = TimelineSwiftDataSync.sync(
            state: timelineState,
            into: &events,
            agentId: eventScopeKey,
            modelContext: modelContext
        )
        if dirty {
            sortEventsForDisplay()
            recomputeGroups()
        }
    }

    /// Keeps the `SessionMessage` mirror (session-list previews, sender
    /// clusters) consistent with a remote edit/delete. `content == nil`
    /// means the row was deleted. Missing row is fine — the cache only
    /// holds messages that arrived over the live stream on this device.
    private func updateSessionMessageCache(messageID: String, content: String?, modelContext: ModelContext) {
        let mid = messageID
        let descriptor = FetchDescriptor<SessionMessage>(predicate: #Predicate { $0.messageId == mid })
        guard let row = try? modelContext.fetch(descriptor).first else { return }
        if let content {
            row.content = content
        } else {
            modelContext.delete(row)
        }
        try? modelContext.save()
        // The edited/deleted message may be quoted by reply chips downstream.
        invalidateReplyQuotes()
    }

    /// Flip isAgentWorking on and arm a long safety reset so a missed
    /// `statusChange:.idle` event doesn't leave the chip stuck in stop.
    /// Also rebuilds `feedItems` so the active-stream "Agent loading"
    /// card appears synchronously — without this, the card would only
    /// surface on the next `recomputeGroups()` trigger (the first ACP
    /// runtime event), which is the latency the user sees on send.
    ///
    /// The reset window (60s) covers a cold-spawn agent's first-delta
    /// latency so the pending card doesn't get cleared mid-wait. The view
    /// layer switches the label to a "请耐心等候" variant after ~15s so
    /// the user knows we're still waiting rather than the indicator
    /// silently dropping.
    private func markAgentWorking() {
        isAgentWorking = true
        recomputeGroups()
        armAgentWorkingSafetyReset()
    }

    /// (Re)arm the 60s safety reset. Split from `markAgentWorking` so the
    /// timeout handler can re-arm itself without flipping the flag.
    private func armAgentWorkingSafetyReset() {
        agentWorkingResetTask?.cancel()
        agentWorkingResetTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard let self, !Task.isCancelled else { return }
            await MainActor.run {
                self.handleAgentWorkingSafetyTimeout()
            }
        }
    }

    /// Complete-output fallback for runtimes that do not publish idle.
    /// `markAgentWorking()` cancels this same task when a follow-on event
    /// arrives, so an output segment immediately followed by a tool call
    /// remains visibly active.
    private func armCompletedOutputSettle(bucket: String) {
        agentWorkingResetTask?.cancel()
        agentWorkingResetTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            await MainActor.run {
                guard self.streamingAgentSet.isEmpty else {
                    self.armAgentWorkingSafetyReset()
                    return
                }
                self.settleAgentTurn(bucket: bucket)
            }
        }
    }

    /// Safety-timer expiry. Clearing `isAgentWorking` is only safe when no
    /// stream is in flight: with a non-empty `streamingAgentSet`, 60 s of
    /// event silence just means a long thinking / tool stretch, and the
    /// old unconditional clear raced the real settle paths — the timer
    /// wiped the flag mid-stream, then a late idle/event operated on
    /// already-cleared state. Re-arm for another period instead; the real
    /// `statusChange:.idle` (or the interrupt settle) owns the flag while
    /// any agent is streaming.
    private func handleAgentWorkingSafetyTimeout() {
        guard streamingAgentSet.isEmpty else {
            armAgentWorkingSafetyReset()
            return
        }
        isAgentWorking = false
        recomputeGroups()
    }

    private func markAgentDone() {
        isAgentWorking = false
        streamingAgentSet.removeAll()
        streamingTextByAgent.removeAll()
        streamingModelByAgent.removeAll()
        streamingTurnIDByAgent.removeAll()
        timelineState.streamingAgentSet = []
        timelineState.streamingTextByAgent = [:]
        timelineState.streamingModelByAgent = [:]
        timelineState.streamingTurnIDByAgent = [:]
        recomputeGroups()
        agentWorkingResetTask?.cancel()
        agentWorkingResetTask = nil
    }

    /// Per-agent turn settle on `statusChange:.idle`. By the time this
    /// runs, the reducer has already flushed the bucket's partial text
    /// into a completed entry and cleared its streaming slots (see
    /// `ChatTimelineReducer` `.statusChange`), and `applyTimelineInput`
    /// mirrored the result. Only the VM-level side effects the reducer
    /// doesn't own happen here — and nothing global: other agents'
    /// in-flight streams must survive one agent finishing.
    private func settleAgentTurn(bucket: String) {
        interruptTimeoutTasks[bucket]?.cancel()
        interruptTimeoutTasks[bucket] = nil
        interruptPendingAgents.remove(bucket)
        // Single session-level "working" chip: idle from any runtime
        // drops it; the next real work event from a still-running agent
        // flips it back on (handleAcpEvent → markAgentWorking).
        isAgentWorking = false
        agentWorkingResetTask?.cancel()
        agentWorkingResetTask = nil
        recomputeGroups()
    }

    /// Arm the ack-timeout fallback for an in-flight cancel. Resolved
    /// early (cancelled) when the daemon's real `statusChange:.idle`
    /// arrives via `settleAgentTurn`.
    private func armInterruptAckTimeout(for bucket: String) {
        interruptTimeoutTasks[bucket]?.cancel()
        interruptTimeoutTasks[bucket] = Task { [weak self, interruptAckTimeout] in
            try? await Task.sleep(for: .seconds(interruptAckTimeout))
            guard let self, !Task.isCancelled else { return }
            self.forceSettleInterruptedAgent(bucket)
        }
    }

    /// Timeout leg: the daemon never acknowledged the cancel. Synthesize
    /// the `statusChange:.idle` locally and run it through the normal
    /// reducer path, so the partial text lands as a completed entry
    /// exactly as a real idle would — then settle the bucket.
    private func forceSettleInterruptedAgent(_ bucket: String) {
        interruptTimeoutTasks[bucket] = nil
        guard interruptPendingAgents.contains(bucket) else { return }
        guard let ctx = startModelContext else {
            interruptPendingAgents.remove(bucket)
            return
        }
        var sc = Amux_AcpStatusChange()
        sc.newStatus = .idle
        var acp = Amux_AcpEvent()
        acp.event = .statusChange(sc)
        let seq = UInt64(max(events.last?.sequence ?? 0, 0)) + 1
        let dirty = applyTimelineInput(
            .acp(AcpInput(
                envelopeSequence: seq,
                agentBucketKey: bucket,
                timestamp: .now,
                turnID: streamingTurnIDByAgent[bucket],
                acpEvent: acp
            )),
            modelContext: ctx
        )
        if dirty { try? ctx.save() }
        settleAgentTurn(bucket: bucket)
    }

    // MARK: - Phase 4 reducer apply + project

    /// Apply one input to the reducer, mirror the reducer-owned auxiliary
    /// state (streaming buffers, availableCommands) onto the VM's
    /// @Observable fields, then project entries into the SwiftData-backed
    /// `events` **only when the reducer changed entries**. Returns `true`
    /// iff the projection mutated the SwiftData `events` array.
    ///
    /// **Fast path:** streaming deltas after the first one return
    /// `.streamingBufferOnly` from the reducer — `state.entries` is
    /// byte-identical. We skip the O(N log N) sort and the O(N) SwiftData
    /// diff entirely, saving the main-thread work that dominated Time
    /// Profiler samples during streaming (dozens of frames per second).
    @discardableResult
    private func applyTimelineInput(_ input: TimelineInput,
                                    modelContext: ModelContext) -> Bool {
        let effect = ChatTimelineReducer.apply(input, to: &timelineState)

        if !timelineState.availableCommands.isEmpty {
            dynamicAvailableCommands = timelineState.availableCommands
        }

        switch effect {
        case .noop:
            mirrorReducerStreamingState()
            return false
        case .streamingBufferOnly:
            // Hot path: only the text buffer grew — entries are
            // byte-identical, so we skip sort + SwiftData diff. The
            // @Observable mirror is throttled too: at delta rates every
            // per-token assignment invalidates ActiveStreamCardView /
            // StreamingDetailView for a render pass, so coalesce to at
            // most one mirror per interval. The first delta of a stream
            // arrives via `.entriesChanged` and mirrors immediately.
            scheduleStreamingMirrorFlush()
            #if DEBUG
            SessionDetailViewModel._testFastPathSkipCount &+= 1
            #endif
            return false
        case .entriesChanged:
            mirrorReducerStreamingState()
            timelineState.entries.sort {
                if $0.timestamp != $1.timestamp { return $0.timestamp < $1.timestamp }
                if $0.sequence != $1.sequence { return $0.sequence < $1.sequence }
                return $0.id < $1.id
            }
            return TimelineSwiftDataSync.sync(
                state: timelineState,
                into: &events,
                agentId: eventScopeKey,
                modelContext: modelContext
            )
        }
    }

    /// Mirror the reducer-owned streaming buffers onto the VM's
    /// @Observable fields. These drive ActiveStreamCardView last-line and
    /// StreamingDetailView live text. Called synchronously on every
    /// entries-changing input and on a throttle for pure text-growth deltas.
    private func mirrorReducerStreamingState() {
        streamingMirrorFlushTask?.cancel()
        streamingMirrorFlushTask = nil
        streamingTextByAgent = timelineState.streamingTextByAgent
        streamingModelByAgent = timelineState.streamingModelByAgent
        streamingAgentSet = timelineState.streamingAgentSet
        streamingTurnIDByAgent = timelineState.streamingTurnIDByAgent
    }

    /// Throttle leg of `mirrorReducerStreamingState` for the per-token
    /// hot path. Keeps the latest reducer text flowing to the UI at
    /// ~10 Hz instead of once per delta. A pending flush is left in
    /// place (not rescheduled) so a continuous stream flushes on a
    /// steady cadence; immediate mirrors cancel it because they already
    /// publish strictly newer state.
    private func scheduleStreamingMirrorFlush() {
        guard streamingMirrorFlushTask == nil else { return }
        streamingMirrorFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard let self, !Task.isCancelled else { return }
            self.streamingMirrorFlushTask = nil
            self.streamingTextByAgent = self.timelineState.streamingTextByAgent
            self.streamingModelByAgent = self.timelineState.streamingModelByAgent
            self.streamingAgentSet = self.timelineState.streamingAgentSet
            self.streamingTurnIDByAgent = self.timelineState.streamingTurnIDByAgent
        }
    }

    /// Rehydrate the reducer's entry state from the SwiftData-loaded
    /// `events` at view-mount time. Without this, the first reducer
    /// applies dedup against an empty state and we'd duplicate every
    /// historical row.
    ///
    /// Streaming buffers are reset to empty: a stop()/start() cycle
    /// (triggered by every NavigationStack push of `StreamingDetailView`)
    /// re-enters this function, and the reducer-owned streaming state
    /// from before the stop is now stale — the matching SwiftData
    /// state was already persisted as a synthetic incomplete-output
    /// entry by `stop()`. Leaving the prior streaming set in place
    /// would short-circuit the `.output(notComplete)` first-delta
    /// path on the next delta (set already contains the bucket), so
    /// the synthetic never gets absorbed, accumulates as orphan
    /// entries in `state.entries`, and bleeds into every subsequent
    /// completedTurn's `runtimeEvents`.
    private func rehydrateTimelineStateFromEvents() {
        timelineState.entries = events.map { event in
            TimelineEntry(
                id: event.id,
                sequence: UInt64(max(event.sequence, 0)),
                eventType: event.eventType,
                text: event.text,
                toolID: event.toolId,
                toolName: event.toolName,
                isComplete: event.isComplete,
                success: event.success,
                senderActorID: event.senderActorID,
                timestamp: event.timestamp,
                model: event.model,
                supabaseMessageID: event.supabaseMessageId,
                outboxMessageID: event.outboxMessageID,
                turnID: event.turnID
            )
        }
        timelineState.streamingTextByAgent = [:]
        timelineState.streamingModelByAgent = [:]
        timelineState.streamingAgentSet = []
        timelineState.streamingTurnIDByAgent = [:]
    }

    /// After a stop()/start() cycle (e.g. NavigationStack push/pop) or a
    /// cold relaunch, check if any persisted incomplete-output events exist
    /// in `events`. If so, agents were mid-stream when stop() (or the
    /// background snapshot) flushed their buffers; restore the streaming
    /// set so every agent's active-stream card reappears immediately
    /// instead of waiting for the next MQTT delta. Multi-agent: stop()
    /// persists one synthetic row per streaming agent — each agent's
    /// NEWEST row wins (the old single-index path restored only the last
    /// row overall, dropping every other agent's text and turn id).
    ///
    /// Status guard: skip restore only when every attachment is known-settled
    /// (3=Idle 4=Error 5=Stopped) — a leftover row then belongs to a finished
    /// turn and must not re-trigger the loading card. No attachment at all
    /// (cold session) means "unknown" and restores: the synthetic rows are
    /// themselves evidence a stream was live moments ago, and a stale
    /// restore is converged back down by the Supabase seed's
    /// residual-streaming cleanup (reducer `.historyMessage`) and the
    /// reconnect turn replay.
    private func restoreStreamingAgentSetFromIncompleteOutput() {
        // Status ints: 1=Starting 2=Active 3=Idle 4=Error 5=Stopped. Restore
        // only while some attachment is still coming up or running; a settled
        // session's incomplete rows are history, not an interrupted stream.
        // No attachment at all means "unknown" — restore, per the note above.
        let live = sessionAttachments
        if !live.isEmpty, !live.contains(where: { $0.status == 1 || $0.status == 2 }) { return }

        var rowsByAgent: [String: [AgentEvent]] = [:]
        for event in events where event.eventType == "output" && event.isComplete == false {
            guard let text = event.text, !text.isEmpty else { continue }
            rowsByAgent[event.senderActorID ?? eventScopeKey, default: []].append(event)
        }
        guard !rowsByAgent.isEmpty else { return }

        for (agentID, rows) in rowsByAgent {
            guard let latest = rows.max(by: {
                ($0.sequence, $0.timestamp) < ($1.sequence, $1.timestamp)
            }) else { continue }
            let text = latest.text ?? ""
            streamingTextByAgent[agentID] = text
            timelineState.streamingTextByAgent[agentID] = text
            if let model = latest.model {
                streamingModelByAgent[agentID] = model
                timelineState.streamingModelByAgent[agentID] = model
            }
            if let turnID = latest.turnID, !turnID.isEmpty {
                streamingTurnIDByAgent[agentID] = turnID
                timelineState.streamingTurnIDByAgent[agentID] = turnID
            }
            streamingAgentSet.insert(agentID)
            timelineState.streamingAgentSet.insert(agentID)

            // Drop the synthetic rows now that their bytes live in the
            // streaming buffer. Keeping them would render the same text
            // twice (bubble + active-stream card) and strand an orphan
            // incomplete entry after the idle flush appends the completed
            // one — the reducer's firstDelta synthetic absorption can't
            // fire once the bucket is already in streamingAgentSet.
            for row in rows {
                if let idx = events.firstIndex(where: { $0 === row }) {
                    removeEvent(at: idx)
                }
                let rowID = row.id
                timelineState.entries.removeAll { $0.id == rowID }
                startModelContext?.delete(row)
            }
        }
        try? startModelContext?.save()
        recomputeGroups()
    }

    public func grantPermission(
        requestId: String,
        agentActorID: String? = nil,
        optionID: String = ""
    ) async throws {
        guard inFlightPermissionRequestIDs.insert(requestId).inserted else { return }
        defer { inFlightPermissionRequestIDs.remove(requestId) }
        var g = Amux_AcpGrantPermission()
        g.requestID = requestId
        g.optionID = optionID
        try await sendCommand(agentActorID: agentActorID) { $0.command = .grantPermission(g) }
        permissionOptionsByRequestID[requestId] = nil
    }
    public func denyPermission(requestId: String, agentActorID: String? = nil) async throws {
        guard inFlightPermissionRequestIDs.insert(requestId).inserted else { return }
        defer { inFlightPermissionRequestIDs.remove(requestId) }
        var d = Amux_AcpDenyPermission(); d.requestID = requestId
        try await sendCommand(agentActorID: agentActorID) { $0.command = .denyPermission(d) }
        permissionOptionsByRequestID[requestId] = nil
    }

    /// ACP options for a pending permission request, falling back to the
    /// OpenCode defaults when the live event wasn't observed (e.g. banner
    /// rendered from persisted history after a relaunch).
    public func permissionOptions(for requestID: String) -> [PermissionOptionItem] {
        permissionOptionsByRequestID[requestID] ?? PermissionOptionItem.openCodeDefaults
    }

    // MARK: - Message feedback

    /// The signed-in user's 👍/👎 per assistant message
    /// (`messageID → "positive" | "negative"`). Loaded once per session
    /// open; mutated optimistically by `setFeedback`.
    public private(set) var feedbackByMessageID: [String: String] = [:]

    /// Loads the caller's existing feedback rows for this session.
    public func loadFeedback() async {
        guard let repo = messagesRepository,
              let sessionID = session?.sessionId, !sessionID.isEmpty,
              let me = currentHumanActorIDRef, !me.isEmpty
        else { return }
        guard let rows = try? await repo.listFeedback(sessionID: sessionID) else { return }
        var mine: [String: String] = [:]
        for row in rows where row.actorID == me {
            mine[row.messageID] = row.kind
        }
        feedbackByMessageID = mine
    }

    /// Sets (or clears, when `kind` is nil / already active) the user's
    /// feedback for a message. Optimistic: the local map flips first and
    /// reverts if the server rejects.
    public func setFeedback(messageID: String, kind: String?) async {
        guard let repo = messagesRepository,
              let me = currentHumanActorIDRef, !me.isEmpty
        else { return }
        let previous = feedbackByMessageID[messageID]
        // Tapping the active choice again clears it.
        let target = (kind == previous) ? nil : kind

        feedbackByMessageID[messageID] = target
        do {
            if let target {
                try await repo.submitFeedback(FeedbackInput(
                    messageID: messageID,
                    actorID: me,
                    teamID: teamID,
                    sessionID: session?.sessionId,
                    kind: target
                ))
            } else {
                try await repo.deleteFeedback(messageID: messageID, actorID: me)
            }
        } catch {
            feedbackByMessageID[messageID] = previous
            surfaceSendError(error)
        }
    }

    // MARK: - Reply quotes

    public struct ReplyQuote: Equatable, Sendable {
        public let messageID: String
        public let senderActorID: String
        public let content: String
    }

    /// Memo for `replyQuote(forSupabaseMessageID:)` — the lookup runs on
    /// the render path for every user-visible row on every body eval, and
    /// almost always concludes "not a reply". Entries are only written once
    /// the message row itself was found (a not-yet-synced row can still
    /// resolve later); replyTo links are immutable, so no per-row
    /// invalidation is needed — content edits clear the whole map.
    private var replyQuoteCache: [String: ReplyQuote?] = [:]

    /// Drops all memoized quotes; call when message content changes so a
    /// quoted snippet can't go stale.
    private func invalidateReplyQuotes() {
        replyQuoteCache = [:]
    }

    /// The message this event replies to, resolved from the SwiftData
    /// `SessionMessage` mirror — both the live and seed paths persist
    /// `replyToMessageId` there, so no timeline plumbing is needed. nil when
    /// the event isn't a reply. A reply whose quoted row isn't cached still
    /// returns (with empty content) so the chip can say "message unavailable"
    /// instead of vanishing.
    public func replyQuote(forSupabaseMessageID id: String?) -> ReplyQuote? {
        guard let id, !id.isEmpty, let ctx = startModelContext else { return nil }
        if let cached = replyQuoteCache[id] { return cached }
        let d1 = FetchDescriptor<SessionMessage>(predicate: #Predicate { $0.messageId == id })
        guard let row = try? ctx.fetch(d1).first else { return nil }
        let replyTo = row.replyToMessageId
        guard !replyTo.isEmpty else {
            replyQuoteCache[id] = ReplyQuote?.none
            return nil
        }
        let d2 = FetchDescriptor<SessionMessage>(predicate: #Predicate { $0.messageId == replyTo })
        let quote: ReplyQuote
        if let quoted = try? ctx.fetch(d2).first {
            quote = ReplyQuote(messageID: replyTo, senderActorID: quoted.senderActorId, content: quoted.content)
            replyQuoteCache[id] = quote
        } else {
            // Quoted row not synced yet — return a placeholder but don't
            // memoize it, so the chip upgrades once the row lands.
            quote = ReplyQuote(messageID: replyTo, senderActorID: "", content: "")
        }
        return quote
    }

    /// Feed anchor for jump-to-quote: the feed item currently rendering
    /// `messageID`, if it is on screen at all.
    public func feedItemID(forSupabaseMessageID messageID: String) -> String? {
        for item in feedItems {
            switch item {
            case .userMessage(let event), .permission(let event), .todo(let event), .error(let event):
                if event.supabaseMessageId == messageID { return item.id }
            case .completedTurn(_, _, let finalEvent, _):
                if finalEvent.supabaseMessageId == messageID { return item.id }
            case .activeStream:
                continue
            }
        }
        return nil
    }

    public func answerQuestion(
        _ question: PendingAcpQuestion,
        answers: [[String]],
        reject: Bool = false
    ) async throws {
        let data = try JSONSerialization.data(withJSONObject: answers)
        guard let answersJSON = String(data: data, encoding: .utf8) else { return }
        var command = Amux_AcpAnswerQuestion()
        command.requestID = question.id
        command.answersJson = answersJSON
        command.reject = reject
        try await sendCommand(agentActorID: question.agentActorID) {
            $0.command = .answerQuestion(command)
        }
        // The daemon also emits question_replied/question_rejected. Remove
        // optimistically after publish so slow broker echo doesn't leave the
        // answered card blocking the composer.
        pendingQuestions.removeAll { $0.id == question.id }
    }
}

// MARK: - Test seams (DEBUG only)

#if DEBUG
extension SessionDetailViewModel {
    /// Builds a minimal VM suitable for unit tests. Uses a stub MQTTService
    /// (no network) and no session/runtime context.
    public static func testInstance() -> SessionDetailViewModel {
        let mqtt = MQTTService()
        return SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "test-team",
            peerId: "test-peer"
        )
    }

    /// Builds a VM with a `Session` inserted into an in-memory SwiftData
    /// container and calls `bind(session:modelContext:)` so that chip-bar
    /// mutations are persisted to `session.selectedAgentIds`.
    @MainActor
    public static func testInstance(session: Session) -> SessionDetailViewModel {
        let mqtt = MQTTService()
        let container = try! ModelContainer(
            for: Session.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        ctx.insert(session)
        let vm = SessionDetailViewModel(
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "test-team",
            peerId: "test-peer",
            session: session
        )
        vm.bind(session: session, modelContext: ctx)
        return vm
    }

    // NSMapTable with weak keys: the container lives as long as the VM does,
    // then both are released together when the test runner deallocates the VM.
    private static let _testStorage = NSMapTable<SessionDetailViewModel, ModelContainer>(
        keyOptions: .weakMemory, valueOptions: .strongMemory
    )

    /// Calls the private `handleIncomingChatMessage` via a per-VM in-memory
    /// ModelContainer whose lifetime is tied to this VM instance. Using a
    /// single retained container prevents the "model instance was destroyed"
    /// crash that occurred when a locally-scoped container was released before
    /// test assertions could read back inserted objects from `vm.events`.
    public func _test_handleIncomingChatMessage(_ message: Teamclu_Message) {
        let container: ModelContainer
        if let existing = Self._testStorage.object(forKey: self) {
            container = existing
        } else {
            guard let fresh = try? ModelContainer(
                for: AgentEvent.self,
                configurations: ModelConfiguration(isStoredInMemoryOnly: true)
            ) else { return }
            Self._testStorage.setObject(fresh, forKey: self)
            container = fresh
        }
        handleIncomingChatMessage(message, modelContext: container.mainContext)
    }

    /// Drive the post-load behaviour of `refreshMemberSheet` directly:
    /// set the agent roster + run the raw-runtime-id relabel pass. Lets
    /// tests exercise the bucket reconciliation without standing up a
    /// Supabase loader.
    public func _test_setMemberSheetAgentsAndRelabel(_ agents: [MemberSheetAgent]) {
        memberSheetAgents = agents
    }

    public func _test_setMemberSheetAgents(_ agents: [MemberSheetAgent]) {
        memberSheetAgents = agents
    }

    public func _test_bucketKey(forActorID runtimeID: String) -> String? {
        bucketKey(forActorID: runtimeID)
    }

    /// Mirrors the production refresh ordering: attach the resolved runtime
    /// to the roster first, then collapse any raw-runtime timeline buckets.
    public func _test_setMemberSheetAgentsOverlayAndRelabel(_ agents: [MemberSheetAgent]) {
        memberSheetAgents = agents
        overlayAttachmentState()
    }

    public func _test_applyOptimisticModelPatch(agentID: String, model: String) {
        applyOptimisticModelPatch(agentID: agentID, model: model)
    }

    public func _test_rollbackOptimisticModelPatch(agentID: String, previousModel: String?) {
        rollbackOptimisticModelPatch(agentID: agentID, previousModel: previousModel)
    }

    public func _test_markPermissionInFlight(_ id: String) {
        inFlightPermissionRequestIDs.insert(id)
    }

    public func _test_removePermissionInFlight(_ id: String) {
        inFlightPermissionRequestIDs.remove(id)
    }

    public func _test_isPermissionInFlight(_ id: String) -> Bool {
        inFlightPermissionRequestIDs.contains(id)
    }

    /// Returns true if the id was NOT already in flight (i.e. the call should proceed).
    public func _test_tryMarkInFlight(_ id: String) -> Bool {
        inFlightPermissionRequestIDs.insert(id).inserted
    }

    /// Returns whether the current member sheet state would cause
    /// scheduleSpawningRefreshIfNeeded() to enqueue a poll.
    public func _test_needsSpawningPoll() -> Bool { needsSpawningPoll }

    /// Exposes the partial-retain merge logic for testing.
    public static func _test_mergeAvailableModels(liveModels: [String], existingModels: [String]) -> [String] {
        if !liveModels.isEmpty { return liveModels }
        if !existingModels.isEmpty { return existingModels }
        return []
    }

    /// Append a raw event to in-memory `events` + `timelineState.entries`
    /// the same way the production live path would, without going through
    /// the reducer. Lets tests seed pre-memberSheet stamps.
    public func _test_appendRawEvent(senderActorID: String, eventType: String, text: String) {
        let event = AgentEvent(agentId: eventScopeKey, sequence: events.count + 1, eventType: eventType)
        event.senderActorID = senderActorID
        event.text = text
        events.append(event)
        timelineState.entries.append(TimelineEntry(
            id: event.id,
            sequence: UInt64(event.sequence),
            eventType: eventType,
            text: text,
            isComplete: false,
            senderActorID: senderActorID,
            timestamp: event.timestamp
        ))
    }

    /// Inject a streaming-buffer entry as if a live ACP output delta had
    /// landed under `bucket` before memberSheet finished loading.
    public func _test_seedStreamingBuffer(bucket: String, text: String, model: String? = nil, turnID: String? = nil) {
        timelineState.streamingAgentSet.insert(bucket)
        timelineState.streamingTextByAgent[bucket] = text
        if let model { timelineState.streamingModelByAgent[bucket] = model }
        if let turnID { timelineState.streamingTurnIDByAgent[bucket] = turnID }
        streamingAgentSet = timelineState.streamingAgentSet
        streamingTextByAgent = timelineState.streamingTextByAgent
        streamingModelByAgent = timelineState.streamingModelByAgent
        streamingTurnIDByAgent = timelineState.streamingTurnIDByAgent
    }

    public func _test_markAgentDone() {
        markAgentDone()
    }

    public func _test_markAgentWorking() {
        markAgentWorking()
    }

    /// Run the 60s safety-timer expiry synchronously (no sleeping in tests).
    public func _test_fireAgentWorkingSafetyTimeout() {
        handleAgentWorkingSafetyTimeout()
    }

    public func _test_armCompletedOutputSettle(bucket: String) {
        armCompletedOutputSettle(bucket: bucket)
    }

    public var _test_streamingTurnIDByAgent: [String: String] {
        streamingTurnIDByAgent
    }

    public var _test_pendingTurnReplayBuckets: Set<String> {
        pendingTurnReplayBuckets
    }

    public func _test_turnReplayRuntimeID(forBucket bucket: String) -> String? {
        turnReplayAddress(forBucket: bucket)
    }

    public func _test_replayStreamingTurnsAfterReconnect(modelContext: ModelContext) async {
        startModelContext = modelContext
        await replayStreamingTurnsAfterReconnect(modelContext: modelContext)
    }

    public func _test_makeInMemoryContainer() -> ModelContainer {
        (try? ModelContainer(
            for: AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        ))!
    }

    /// Simulates stop(): flushes streaming buffers to incomplete events in
    /// `modelContext`, then clears all streaming state. Bypasses the
    /// `runtime != nil` guard so unit tests without a live runtime can exercise
    /// the flush path.
    public func _test_stop(modelContext: ModelContext) {
        startModelContext = modelContext
        mirrorReducerStreamingState()
        var seq = (events.last?.sequence ?? 0) + 1
        for agentID in streamingAgentSet {
            guard let text = streamingTextByAgent[agentID], !text.isEmpty else { continue }
            let event = AgentEvent(agentId: eventScopeKey, sequence: seq, eventType: "output")
            event.senderActorID = agentID
            event.text = text
            event.isComplete = false
            event.model = streamingModelByAgent[agentID]
            event.turnID = streamingTurnIDByAgent[agentID]
            modelContext.insert(event)
            appendEvent(event)
            seq += 1
        }
        try? modelContext.save()
        streamingAgentSet.removeAll()
        streamingTextByAgent.removeAll()
        streamingModelByAgent.removeAll()
        streamingTurnIDByAgent.removeAll()
        recomputeGroups()
    }

    /// Simulates start(): reloads events from `modelContext` and restores
    /// streaming state from any persisted incomplete output events.
    public func _test_start(modelContext: ModelContext) {
        startModelContext = modelContext
        let scope = eventScopeKey
        let descriptor = FetchDescriptor<AgentEvent>(
            predicate: #Predicate { $0.agentId == scope },
            sortBy: [SortDescriptor(\.timestamp), SortDescriptor(\.sequence)]
        )
        events = (try? modelContext.fetch(descriptor)) ?? []
        rehydrateTimelineStateFromEvents()
        restoreStreamingAgentSetFromIncompleteOutput()
    }
}

extension SessionParticipant {
    public static func testFixture(actorID: String, role: String, displayName: String) -> SessionParticipant {
        SessionParticipant(actorID: actorID, role: role, displayName: displayName)
    }
}

extension MemberSheetAgent {
    public static func testFixture(
        id: String,
        displayName: String? = nil
    ) -> MemberSheetAgent {
        MemberSheetAgent(
            id: id,
            displayName: displayName ?? id,
            workspacePath: "",
            agentType: "claude",
            lifecycleState: .idle,
            availableModels: [],
            currentModel: nil,
            workspaceID: nil,
            backendType: nil
        )
    }
}

extension SessionDetailViewModel {
    /// Sets `memberSheetAgents` to the given snapshot and prunes any ghost
    /// agent IDs from `agentChipSelection`. For use in unit tests only.
    @MainActor
    public func applyMemberSheetSnapshotForTests(agents: [MemberSheetAgent]) {
        memberSheetAgents = agents
        pruneGhostAgentSelection()
    }
}

extension SessionDetailViewModel {
    /// Counts fast-path skips (streaming-buffer-only deltas that bypassed
    /// sort + SwiftData sync). Incremented by `applyTimelineInput` only in
    /// DEBUG builds. Stored on the type to avoid the stored-property-in-
    /// extension restriction on @Observable classes; tests that call this
    /// should be serial to avoid data races on the counter.
    nonisolated(unsafe) public static var _testFastPathSkipCount: Int = 0

    /// Synchronously run the throttled streaming-buffer mirror so tests
    /// can assert on the @Observable fields without sleeping through the
    /// flush interval.
    @MainActor
    public func _testFlushStreamingMirror() {
        mirrorReducerStreamingState()
    }

    /// Direct test entry: run a full ACP event through `handleAcpEvent`
    /// (reducer + VM side effects like per-agent idle settle) without a
    /// live MQTT session. `runtimeID` doubles as the bucket key when it
    /// isn't in `memberSheetAgents` (raw-id fallback in `bucketKey`).
    @MainActor
    public func _testHandleAcp(_ acp: Amux_AcpEvent,
                               sequence: Int,
                               runtimeID: String,
                               modelContext: ModelContext) {
        startModelContext = modelContext
        _ = handleAcpEvent(acp, sequence: sequence, runtimeID: runtimeID,
                           modelContext: modelContext)
    }

    /// Simulate an in-flight cancel (membership only, no MQTT publish)
    /// and immediately run the ack-timeout leg, so tests can exercise
    /// the force-settle path without sleeping through the timeout.
    @MainActor
    public func _testForceSettleInterrupt(bucket: String, modelContext: ModelContext) {
        startModelContext = modelContext
        interruptPendingAgents.insert(bucket)
        forceSettleInterruptedAgent(bucket)
    }

    /// Direct test entry: build an AcpInput and run it through
    /// `applyTimelineInput` without a live MQTT session.
    @MainActor
    public func _testApplyAcp(_ acp: Amux_AcpEvent,
                              sequence: Int,
                              agentBucketKey: String,
                              modelContext: ModelContext) {
        _ = applyTimelineInput(
            .acp(AcpInput(
                envelopeSequence: UInt64(sequence),
                agentBucketKey: agentBucketKey,
                timestamp: .now,
                turnID: nil,
                acpEvent: acp
            )),
            modelContext: modelContext
        )
    }
}
#endif
