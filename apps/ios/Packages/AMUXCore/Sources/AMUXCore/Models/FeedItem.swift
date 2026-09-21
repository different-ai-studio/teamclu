import Foundation

/// A row in the main chat feed. Higher-level than `GroupedEvent`: hides
/// in-turn runtime detail (thinking, tool_use, tool_result) behind an
/// active-stream card or a completed-turn bubble, so multi-agent sessions
/// don't drown the user in interleaved runtime events from concurrent
/// agents.
///
/// ## Per-turn semantics
///
/// A "turn" for one agent runs from its first runtime event after a user
/// prompt until the agent emits a complete `output` event. While the turn
/// is open it appears in the feed as `.activeStream`; once the final
/// output lands it converts to `.completedTurn` at that chronological
/// position. Multiple agents can have concurrent open turns — each gets
/// its own card.
///
/// A daemon turn that gets cut by a ToolUse mid-stream flushes as
/// multiple `output{isComplete=true}` rows sharing one `turnID`. The
/// feed collapses them so one prompt yields one bubble: the latest
/// output becomes `finalEvent`, earlier outputs + intervening tools
/// fold into `runtimeEvents` for the detail view. If the turn is still
/// in flight when a later segment is streaming, the prior bubble is
/// removed and its content folds into the trailing `.activeStream` so
/// the chat shows one in-progress item per agent.
public enum FeedItem: Identifiable {
    /// A user prompt or another collaborator's chat message. Owns
    /// alignment + sender labeling at the view layer.
    case userMessage(AgentEvent)
    /// One agent's currently-running turn. The `agentID` keys into the
    /// view-model's streaming buffers for the live preview line; the
    /// detail view renders the full event list when tapped.
    case activeStream(id: String, agentID: String, runtimeEvents: [AgentEvent])
    /// One agent's finished turn. The main feed shows only `finalEvent`'s
    /// text in the gray assistant bubble; the runtime events are kept
    /// alongside for the detail view's "show streaming history" path.
    case completedTurn(id: String, agentID: String, finalEvent: AgentEvent, runtimeEvents: [AgentEvent])
    /// Pending permission request — kept in the main feed because it
    /// requires immediate user action.
    case permission(AgentEvent)
    /// Daemon-pushed todo snapshot for the current turn — kept in the
    /// main feed because users routinely scan it for plan progress.
    case todo(AgentEvent)
    /// Runtime error surfaced by the agent — kept in the main feed so the
    /// user notices it without having to drill into a stream view.
    case error(AgentEvent)

    public var id: String {
        switch self {
        case .userMessage(let e): return "user-\(e.id)"
        case .activeStream(let id, _, _): return id
        case .completedTurn(let id, _, _, _): return id
        case .permission(let e): return "perm-\(e.id)"
        case .todo(let e): return "todo-\(e.id)"
        case .error(let e): return "err-\(e.id)"
        }
    }
}

/// Build the chat feed by walking events in order, accumulating per-agent
/// runtime detail into open turns, and emitting completed turns at their
/// chronological close points. Trailing open turns + the
/// `streamingAgentIDs` set produce trailing `.activeStream` cards.
///
/// `streamingAgentIDs` covers the case where the agent has begun
/// streaming raw text deltas before any other runtime event arrived — we
/// want a card up immediately even though `events` doesn't yet have a
/// row for that agent's turn.
public func buildFeedItems(_ events: [AgentEvent],
                           streamingAgentIDs: Set<String> = []) -> [FeedItem] {
    var openTurnsByAgent: [String: [AgentEvent]] = [:]
    var openTurnFirstEventID: [String: String] = [:]
    var openTurnTurnIDByAgent: [String: String] = [:]
    var result: [FeedItem] = []

    // Index of the latest `.completedTurn` per (agent, turnID). A daemon
    // turn can flush as multiple `output{isComplete=true}` rows when a
    // ToolUse cuts the stream mid-turn — without this index each segment
    // would render as its own bubble. With it, the later segment merges
    // back into the earlier bubble: the new output becomes `finalEvent`
    // (so the bubble shows the latest text) and the prior `finalEvent`
    // plus any intervening tools fold into `runtimeEvents` for the
    // detail view.
    var completedTurnIndexByKey: [String: Int] = [:]

    func ownerFor(_ event: AgentEvent) -> String {
        // Empty senderActorID falls back to a synthetic key so missing-
        // attribution events still get a stable bucket; better to share
        // a degenerate bucket than to cross-attribute to a real agent.
        let raw = event.senderActorID ?? ""
        return raw.isEmpty ? "(unattributed)" : raw
    }

    func recordOpenTurn(_ event: AgentEvent, owner: String) {
        openTurnsByAgent[owner, default: []].append(event)
        if openTurnFirstEventID[owner] == nil {
            openTurnFirstEventID[owner] = event.id
        }
        if openTurnTurnIDByAgent[owner] == nil,
           let t = event.turnID, !t.isEmpty {
            openTurnTurnIDByAgent[owner] = t
        }
    }

    func turnKey(owner: String, turnID: String?) -> String? {
        guard let t = turnID, !t.isEmpty else { return nil }
        return "\(owner)|\(t)"
    }

    for event in events {
        let owner = ownerFor(event)
        switch event.eventType {
        case "user_prompt":
            result.append(.userMessage(event))
        case "permission_request":
            result.append(.permission(event))
        case "plan_update":
            result.append(.todo(event))
        case "error":
            result.append(.error(event))
        case "thinking", "tool_use", "tool_result":
            recordOpenTurn(event, owner: owner)
        case "output":
            if event.isComplete {
                let runtime = openTurnsByAgent[owner] ?? []
                openTurnsByAgent[owner] = nil
                openTurnFirstEventID[owner] = nil
                openTurnTurnIDByAgent[owner] = nil
                // Prefer daemon-assigned turnID so cross-device
                // `TurnRoute.frozenTurnID` lands on the same turn from
                // any client. Fallback to the synthetic id keeps
                // pre-turn_id rows navigable.
                let turnID = (event.turnID?.isEmpty == false ? event.turnID! : "turn-\(event.id)")
                let key = turnKey(owner: owner, turnID: event.turnID)
                if let key,
                   let idx = completedTurnIndexByKey[key],
                   case let .completedTurn(existingID, existingAgent, oldFinal, oldRuntime) = result[idx] {
                    let mergedRuntime = oldRuntime + [oldFinal] + runtime
                    result[idx] = .completedTurn(
                        id: existingID,
                        agentID: existingAgent,
                        finalEvent: event,
                        runtimeEvents: mergedRuntime
                    )
                } else {
                    result.append(.completedTurn(
                        id: turnID,
                        agentID: owner,
                        finalEvent: event,
                        runtimeEvents: runtime
                    ))
                    if let key { completedTurnIndexByKey[key] = result.count - 1 }
                }
            } else {
                // Persisted incomplete output (stop()-saved synthetic
                // event re-applied across cold start). Treat as part of
                // the open turn — the active-stream card surfaces it.
                recordOpenTurn(event, owner: owner)
            }
        default:
            // Unknown / future event types fall through to a single row
            // so they remain at least debuggable.
            result.append(.userMessage(event))
        }
    }

    // Trailing live state: any agent with an open turn OR currently
    // streaming raw text gets an active-stream card at the end of the
    // feed. Sorted by the first event id of the open turn so concurrent
    // agents render in the order they started speaking.
    //
    // Mid-turn fold: when the open turn shares a turnID with an earlier
    // `.completedTurn` (text→tool→…still working), drop the prior bubble
    // and prepend its events into the active-stream's runtime — the
    // chat shows ONE in-progress item per agent. `activeStreamLastLine`
    // surfaces the live streaming buffer first and falls back to the
    // most recent output text we just folded in, so the user keeps
    // seeing the latest segment while the tool runs.
    let liveAgents = Set(openTurnsByAgent.keys).union(streamingAgentIDs)
    let ordered = liveAgents.sorted { lhs, rhs in
        (openTurnFirstEventID[lhs] ?? lhs) < (openTurnFirstEventID[rhs] ?? rhs)
    }
    var foldedIndices = Set<Int>()
    var trailing: [(agentID: String, runtime: [AgentEvent])] = []
    for agentID in ordered {
        var runtime = openTurnsByAgent[agentID] ?? []
        if let turnID = openTurnTurnIDByAgent[agentID],
           let key = turnKey(owner: agentID, turnID: turnID),
           let idx = completedTurnIndexByKey[key],
           case let .completedTurn(_, _, oldFinal, oldRuntime) = result[idx] {
            runtime = oldRuntime + [oldFinal] + runtime
            foldedIndices.insert(idx)
        }
        trailing.append((agentID, runtime))
    }
    if !foldedIndices.isEmpty {
        var filtered: [FeedItem] = []
        filtered.reserveCapacity(result.count - foldedIndices.count)
        for (i, item) in result.enumerated() where !foldedIndices.contains(i) {
            filtered.append(item)
        }
        result = filtered
    }
    for t in trailing {
        result.append(.activeStream(
            id: "stream-\(t.agentID)",
            agentID: t.agentID,
            runtimeEvents: t.runtime
        ))
    }

    // The card of the turn a permission request came out of: its completed
    // bubble, or the agent's still-running stream card.
    func turnAnchor(for event: AgentEvent, in items: [FeedItem]) -> Int? {
        let turnID = event.turnID ?? ""
        let owner = ownerFor(event)
        return items.firstIndex { item in
            switch item {
            case let .completedTurn(id, agentID, final, _):
                guard !turnID.isEmpty else { return agentID == owner }
                return final.turnID == turnID || id == turnID
            case let .activeStream(_, agentID, _):
                return agentID == owner
            default:
                return false
            }
        }
    }

    // An answered permission leaves the chat. The decision is already made,
    // so the card is only noise sitting between the prompt and the reply —
    // it folds into its turn's runtime events, where the turn detail view
    // shows it alongside the tool it was gating. A request whose turn isn't
    // in this feed keeps its row rather than disappearing with nowhere left
    // to read it.
    //
    // Lifted out and put back rather than shuffled in place: an anchor can
    // sit either side of the row (active-stream cards are appended after the
    // whole walk), and in-place index juggling around that is where the
    // non-terminating version of this lived.
    var answered: [(event: AgentEvent, fallbackIndex: Int)] = []
    var unanswered: [FeedItem] = []
    unanswered.reserveCapacity(result.count)
    for item in result {
        if case let .permission(event) = item, event.isComplete {
            answered.append((event, unanswered.count))
        } else {
            unanswered.append(item)
        }
    }

    if !answered.isEmpty {
        result = unanswered
        for entry in answered {
            guard let anchor = turnAnchor(for: entry.event, in: result) else {
                result.insert(.permission(entry.event), at: min(entry.fallbackIndex, result.count))
                continue
            }
            switch result[anchor] {
            case let .completedTurn(id, agentID, final, runtime):
                result[anchor] = .completedTurn(
                    id: id, agentID: agentID, finalEvent: final, runtimeEvents: runtime + [entry.event]
                )
            case let .activeStream(id, agentID, runtime):
                result[anchor] = .activeStream(
                    id: id, agentID: agentID, runtimeEvents: runtime + [entry.event]
                )
            default:
                result.insert(.permission(entry.event), at: min(entry.fallbackIndex, result.count))
            }
        }
    }

    // Placement of the ones still waiting on the user: a request comes out of
    // a turn, so it reads UNDER that turn's card — the agent thinks, then
    // asks. Neither the walk above nor a time sort gets there on its own. A
    // completed reply's timestamp is the turn's START (Supabase
    // `created_at`), and active-stream cards are appended after the whole
    // walk, so either can sort ahead of the request that produced it.
    //
    // Lift them all out first, then put them back. Shuffling them in place
    // does not terminate: two requests sharing one anchor each skip past the
    // other looking for the end of the run under that card, and trade places
    // forever.
    var pendingRows: [(row: FeedItem, event: AgentEvent, fallbackIndex: Int)] = []
    var placed: [FeedItem] = []
    placed.reserveCapacity(result.count)
    for item in result {
        if case let .permission(event) = item {
            // Where it sits once the other permissions are gone — the spot it
            // returns to if its turn isn't in this feed.
            pendingRows.append((item, event, placed.count))
        } else {
            placed.append(item)
        }
    }

    if !pendingRows.isEmpty {
        result = placed
        for pending in pendingRows {
            guard let anchor = turnAnchor(for: pending.event, in: result) else {
                result.insert(pending.row, at: min(pending.fallbackIndex, result.count))
                continue
            }
            // A waiting request is answerable from either surface, so it goes
            // into the turn's runtime events as well as keeping its feed row.
            // Runtime events are detail-only — the feed renders a turn from
            // its card, never from this list — so this doesn't double it up
            // in the chat.
            switch result[anchor] {
            case let .completedTurn(id, agentID, final, runtime):
                result[anchor] = .completedTurn(
                    id: id, agentID: agentID, finalEvent: final,
                    runtimeEvents: runtime + [pending.event]
                )
            case let .activeStream(id, agentID, runtime):
                result[anchor] = .activeStream(
                    id: id, agentID: agentID, runtimeEvents: runtime + [pending.event]
                )
            default:
                break
            }
            // Several requests out of one turn keep the order they were asked
            // in: each lands after the ones already placed under that card.
            // Folding above replaces an element, it doesn't shift indices, so
            // the anchor is still where it was.
            var target = anchor + 1
            while target < result.count, case .permission = result[target] { target += 1 }
            result.insert(pending.row, at: target)
        }
    }

    return result
}
