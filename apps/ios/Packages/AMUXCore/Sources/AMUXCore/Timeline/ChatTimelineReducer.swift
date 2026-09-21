import Foundation

/// Pure-value reducer over the timeline state. Encodes the contract
/// documented in `TimelineInput.swift` (the seven in-place mutation
/// cases + per-variant identity / ordering keys) so that production
/// migration off the inline-handler path in `SessionDetailViewModel`
/// has a fixed target.
///
/// **Not wired into production yet.** Lives here as the executable
/// contract anchor for Phase 4 main. The surrounding store + view
/// migration that consumes this reducer needs recorded session traces
/// to land safely; that's the prerequisite. Until then this file +
/// `ChatTimelineReducerTests` documents the intended semantics in
/// runnable form, decoupled from SwiftData and SwiftUI.
public enum ChatTimelineReducer {

    /// Apply one input to the state. Idempotent under replay when the
    /// input's identity key has already been seen — re-applying the
    /// same `(.acp envelopeSequence)` / `.liveMessage messageID` /
    /// `.historyMessage supabaseMessageID` / `.localPrompt clientID` /
    /// `.permissionResolution requestID` is a no-op.
    ///
    /// Returns a `TimelineReducerEffect` describing what changed, letting
    /// callers skip expensive sort + SwiftData projection on hot paths
    /// where only streaming buffers were touched.
    @discardableResult
    public static func apply(_ input: TimelineInput,
                             to state: inout TimelineState) -> TimelineReducerEffect {
        switch input {
        case .acp(let a): return applyAcp(a, to: &state)
        case .liveMessage(let m): return applyLive(m, to: &state)
        case .historyMessage(let h): return applyHistory(h, to: &state)
        case .localPrompt(let p): return applyLocal(p, to: &state)
        case .permissionResolution(let r): return applyPermission(r, to: &state)
        }
    }

    // MARK: - .acp

    @discardableResult
    static func applyAcp(_ input: AcpInput, to state: inout TimelineState) -> TimelineReducerEffect {
        let bucket = input.agentBucketKey

        // Turn-id dedupe (primary): same (bucket, turnID, output, isComplete)
        // → idempotent merge regardless of sequence. This is what catches the
        // "same logical completion arrives via MQTT live + daemon history
        // replay + Supabase seed" duplication, since the daemon stamps
        // turn_id on every envelope but renumbers sequence across restarts.
        // Only the completion event needs this guard; deltas and other
        // event types either don't dedupe by identity (deltas → streaming
        // buffer) or arrive at most once per (sequence, bucket).
        if case .output(let outComplete) = input.acpEvent.event,
           outComplete.isComplete,
           let turnID = input.turnID,
           !turnID.isEmpty,
           let idx = outputCompleteIndex(for: bucket, turnID: turnID, in: state) {
            state.entries[idx].text = outComplete.text
            if !input.acpEvent.model.isEmpty {
                state.entries[idx].model = input.acpEvent.model
            }
            state.streamingAgentSet.remove(bucket)
            state.streamingTextByAgent[bucket] = nil
            state.streamingModelByAgent[bucket] = nil
            state.streamingTurnIDByAgent[bucket] = nil
            return .entriesChanged
        }

        // Sequence dedupe (fallback): same (sequence, bucket) → no-op.
        // Holds across re-applications in a single daemon lifetime; does
        // NOT survive daemon restarts (sequences renumber) — that's why
        // the turn-id guard above is the primary path.
        if input.envelopeSequence > 0,
           state.entries.contains(where: { $0.sequence == input.envelopeSequence
                                            && ($0.senderActorID ?? "") == input.agentBucketKey }) {
            return .noop
        }

        switch input.acpEvent.event {
        case .output(let o):
            if o.isComplete {
                state.streamingAgentSet.remove(bucket)
                if let idx = incompleteOutputIndex(for: bucket, in: state) {
                    state.entries[idx].text = o.text
                    state.entries[idx].isComplete = true
                    // Backfill turnID so future replays for this turn match
                    // by (bucket, turnID) and don't fall through to append.
                    if let turnID = input.turnID,
                       !turnID.isEmpty,
                       state.entries[idx].turnID == nil {
                        state.entries[idx].turnID = turnID
                    }
                    if !input.acpEvent.model.isEmpty {
                        state.entries[idx].model = input.acpEvent.model
                    }
                } else {
                    state.entries.append(makeEntry(
                        sequence: input.envelopeSequence,
                        eventType: "output",
                        text: o.text,
                        senderActorID: bucket,
                        timestamp: input.timestamp,
                        model: input.acpEvent.model.isEmpty ? nil : input.acpEvent.model,
                        isComplete: true,
                        turnID: input.turnID
                    ))
                }
                state.streamingTextByAgent[bucket] = nil
                state.streamingModelByAgent[bucket] = nil
                state.streamingTurnIDByAgent[bucket] = nil
                return .entriesChanged
            } else {
                // A new turn is a hard streaming boundary. In normal flow
                // the prior turn's idle event clears this buffer, but MQTT
                // can drop that trailing lifecycle envelope. Without this
                // guard, the first delta of the next turn appends onto the
                // old reply, producing the repeated-message prefix seen in
                // session detail and leaving its loading card alive.
                if let incomingTurnID = input.turnID,
                   !incomingTurnID.isEmpty,
                   let activeTurnID = state.streamingTurnIDByAgent[bucket],
                   !activeTurnID.isEmpty,
                   activeTurnID != incomingTurnID {
                    state.streamingAgentSet.remove(bucket)
                    state.streamingTextByAgent[bucket] = nil
                    state.streamingModelByAgent[bucket] = nil
                    state.streamingTurnIDByAgent[bucket] = nil
                }
                let firstDelta = !state.streamingAgentSet.contains(bucket)
                var absorbedSynthetic = false
                if firstDelta, let idx = incompleteOutputIndex(for: bucket, in: state) {
                    // Drop the synthetic stop()-saved entry: its text
                    // seeds the streaming buffer, then it goes away.
                    state.streamingTextByAgent[bucket] = state.entries[idx].text ?? ""
                    state.entries.remove(at: idx)
                    absorbedSynthetic = true
                }
                state.streamingAgentSet.insert(bucket)
                state.streamingTextByAgent[bucket, default: ""] += o.text
                if !input.acpEvent.model.isEmpty {
                    state.streamingModelByAgent[bucket] = input.acpEvent.model
                }
                // Track the active turn id so the MQTT subscribe loop can
                // replay missing envelopes (incl. trailing `idle`) after a
                // reconnect — the broker may have dropped them on the
                // floor while we were disconnected.
                if let turnID = input.turnID, !turnID.isEmpty {
                    state.streamingTurnIDByAgent[bucket] = turnID
                }
                // Return entriesChanged only if we removed a synthetic entry.
                // All subsequent deltas are buffer-only — the hot path.
                return absorbedSynthetic ? .entriesChanged : .streamingBufferOnly
            }

        case .thinking(let t):
            if let lastIdx = state.entries.indices.last,
               state.entries[lastIdx].eventType == "thinking",
               (state.entries[lastIdx].senderActorID ?? "") == bucket {
                state.entries[lastIdx].text = (state.entries[lastIdx].text ?? "") + t.text
                if !input.acpEvent.model.isEmpty {
                    state.entries[lastIdx].model = input.acpEvent.model
                }
            } else {
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "thinking",
                    text: t.text,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    model: input.acpEvent.model.isEmpty ? nil : input.acpEvent.model,
                    turnID: input.turnID
                ))
            }
            return .entriesChanged

        case .toolUse(let tu):
            // Mid-turn text flush: if the streaming buffer holds reply
            // text that the agent emitted before this tool call, persist
            // it as its own complete output entry first so the detail
            // view shows text → tool → text instead of all-tools-then-
            // text. The streaming buffer keeps accumulating after the
            // tool returns; the next ToolUse or the Active→Idle flush
            // produces another per-segment entry.
            //
            // sequence = 0 marks this as a synthetic entry not tied to
            // a single envelope, so the envelopeSequence dedupe at the
            // top doesn't mistake it for the originating ToolUse
            // envelope. Replay dedupe: identical (bucket, turnID, text)
            // already-flushed segments are skipped so requestTurnHistory
            // doesn't double-emit.
            if state.streamingAgentSet.contains(bucket),
               let bufferedText = state.streamingTextByAgent[bucket],
               !bufferedText.isEmpty {
                let segmentTurnID = state.streamingTurnIDByAgent[bucket] ?? input.turnID
                let alreadyFlushed = state.entries.contains { entry in
                    entry.eventType == "output"
                        && entry.isComplete
                        && (entry.senderActorID ?? "") == bucket
                        && entry.turnID == segmentTurnID
                        && entry.text == bufferedText
                }
                if !alreadyFlushed {
                    state.entries.append(makeEntry(
                        sequence: 0,
                        eventType: "output",
                        text: bufferedText,
                        senderActorID: bucket,
                        timestamp: input.timestamp,
                        model: state.streamingModelByAgent[bucket],
                        isComplete: true,
                        turnID: segmentTurnID
                    ))
                }
                state.streamingTextByAgent[bucket] = nil
                // streamingAgentSet stays — the turn is still in flight,
                // and the next delta should keep appending to a fresh
                // buffer without re-entering the firstDelta seed path.
            }

            if let idx = state.entries.lastIndex(where: { $0.eventType == "tool_use" && $0.toolID == tu.toolID }) {
                if !tu.description_p.isEmpty {
                    state.entries[idx].text = tu.description_p
                }
                if !tu.toolName.isEmpty {
                    state.entries[idx].toolName = tu.toolName
                }
                if state.entries[idx].toolID == nil {
                    state.entries[idx].toolID = tu.toolID
                }
                if let diff = firstDiff(tu.content) {
                    applyDiff(diff, to: &state.entries[idx])
                }
            } else {
                var entry = makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "tool_use",
                    text: tu.description_p,
                    toolID: tu.toolID,
                    toolName: tu.toolName,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    turnID: input.turnID
                )
                if let diff = firstDiff(tu.content) {
                    applyDiff(diff, to: &entry)
                }
                state.entries.append(entry)
            }
            return .entriesChanged

        case .toolResult(let tr):
            if let idx = state.entries.lastIndex(where: { $0.eventType == "tool_use" && $0.toolID == tr.toolID }) {
                state.entries[idx].success = tr.success
                state.entries[idx].resultSummary = tr.summary
                state.entries[idx].isComplete = true
                if let diff = firstDiff(tr.content) {
                    applyDiff(diff, to: &state.entries[idx])
                }
            } else {
                // Out-of-order arrival — append a standalone tool_result.
                // Carry the diff too: when the ToolUse envelope was lost
                // (mid-turn subscribe), this entry is the only place the
                // edit's content can survive.
                var entry = makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "tool_result",
                    text: tr.summary,
                    toolID: tr.toolID,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    isComplete: true,
                    success: tr.success,
                    turnID: input.turnID
                )
                if let diff = firstDiff(tr.content) {
                    applyDiff(diff, to: &entry)
                }
                state.entries.append(entry)
            }
            return .entriesChanged

        case .error(let e):
            state.entries.append(makeEntry(
                sequence: input.envelopeSequence,
                eventType: "error",
                text: e.message,
                senderActorID: bucket,
                timestamp: input.timestamp
            ))
            return .entriesChanged

        case .permissionRequest(let pr):
            // Identity dedupe by requestID: a turn-history replay carries
            // the same request again (daemon restarts renumber sequences,
            // so the sequence guard can miss). Re-appending would duplicate
            // the card at the feed's tail — and clobber the original's
            // resolved state.
            if state.entries.contains(where: {
                $0.eventType == "permission_request" && $0.toolID == pr.requestID
            }) {
                return .noop
            }
            state.entries.append(makeEntry(
                sequence: input.envelopeSequence,
                eventType: "permission_request",
                text: pr.description_p,
                toolID: pr.requestID,
                toolName: pr.toolName,
                senderActorID: bucket,
                timestamp: input.timestamp,
                // Anchor: buildFeedItems places a pending permission row
                // under its turn's card, and folds an answered one into that
                // turn's runtime events. Both need the turn id — the reply
                // row's timestamp is the turn's START, so time alone doesn't
                // say which turn a mid-turn request belongs to.
                turnID: input.turnID
            ))
            return .entriesChanged

        case .planUpdate(let pu):
            let text = pu.entries.map { entry -> String in
                let icon = entry.status == "completed" ? "done"
                         : entry.status == "in_progress" ? "wip"
                         : "todo"
                return "[\(icon)] \(entry.content)"
            }.joined(separator: "\n")
            if let idx = state.entries.lastIndex(where: {
                $0.eventType == "plan_update"
                    && ($0.senderActorID ?? "") == bucket
            }) {
                state.entries[idx].text = text
                if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            } else {
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "plan_update",
                    text: text,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    turnID: input.turnID
                ))
            }
            return .entriesChanged

        case .statusChange(let sc):
            var didMutateEntries = false
            if sc.newStatus == .idle, state.streamingAgentSet.contains(bucket),
               let text = state.streamingTextByAgent[bucket], !text.isEmpty {
                // Stamp the turnID we tracked across deltas so this final
                // segment groups with any earlier mid-turn flushes under
                // the same `.completedTurn`.
                let segmentTurnID = state.streamingTurnIDByAgent[bucket] ?? input.turnID
                let alreadyFlushed = state.entries.contains { entry in
                    entry.eventType == "output"
                        && entry.isComplete
                        && (entry.senderActorID ?? "") == bucket
                        && entry.turnID == segmentTurnID
                        && entry.text == text
                }
                if !alreadyFlushed {
                    state.entries.append(makeEntry(
                        sequence: input.envelopeSequence,
                        eventType: "output",
                        text: text,
                        senderActorID: bucket,
                        timestamp: input.timestamp,
                        model: state.streamingModelByAgent[bucket],
                        isComplete: true,
                        turnID: segmentTurnID
                    ))
                    didMutateEntries = true
                }
            }
            if sc.newStatus == .idle {
                state.streamingAgentSet.remove(bucket)
                state.streamingTextByAgent[bucket] = nil
                state.streamingModelByAgent[bucket] = nil
                state.streamingTurnIDByAgent[bucket] = nil
                // Close any open tool_use rows from this bucket.
                for i in state.entries.indices where state.entries[i].eventType == "tool_use"
                    && !state.entries[i].isComplete
                    && (state.entries[i].senderActorID ?? "") == bucket {
                    state.entries[i].isComplete = true
                    if state.entries[i].success == nil { state.entries[i].success = true }
                    didMutateEntries = true
                }
                return didMutateEntries ? .entriesChanged : .streamingBufferOnly
            }
            return .noop

        case .availableCommands(let upd):
            var seen = Set<String>()
            let next = upd.commands
                .filter { !$0.name.isEmpty && seen.insert($0.name).inserted }
                .map { SlashCommand(name: $0.name,
                                    description: $0.description_p,
                                    inputHint: $0.inputHint) }
            if next != state.availableCommands {
                state.availableCommands = next
                return .streamingBufferOnly
            }
            return .noop

        case .raw, .none:
            // Raw tool_title_update + future event types: leave the
            // entries alone. The production VM has a hand-rolled
            // parser for `tool_title_update`; that's intentionally
            // outside the reducer's MVP scope. Other `raw` payloads
            // are ignored.
            return .noop
        }
    }

    // MARK: - .liveMessage

    @discardableResult
    static func applyLive(_ input: LiveMessageInput, to state: inout TimelineState) -> TimelineReducerEffect {
        // Identity dedupe: messageID already present → no-op.
        if state.entries.contains(where: { $0.id == input.messageID }) { return .noop }

        // Local prompt merge: same clientID round-tripped from a prior
        // .localPrompt → replace that entry in place. We swap the id
        // for the server-assigned messageID so future history seeds
        // dedupe correctly.
        if let clientLocalID = input.clientLocalID,
           let idx = state.entries.firstIndex(where: { $0.clientID == clientLocalID }) {
            state.entries[idx].id = input.messageID
            state.entries[idx].clientID = nil
            state.entries[idx].timestamp = input.createdAt
            return .entriesChanged
        }

        state.entries.append(TimelineEntry(
            id: input.messageID,
            eventType: "user_prompt",
            text: input.content,
            isComplete: true,
            senderActorID: input.senderActorID,
            timestamp: input.createdAt
        ))
        return .entriesChanged
    }

    // MARK: - .historyMessage

    @discardableResult
    static func applyHistory(_ input: HistoryInput, to state: inout TimelineState) -> TimelineReducerEffect {
        let effect = applyHistoryRow(input, to: &state)
        guard input.kind == .output,
              let bucket = input.senderActorID,
              !bucket.isEmpty
        else { return effect }

        // A row carrying a trace pointer is the turn's final reply, so the
        // turn is over no matter what the saved partial holds. The partial
        // often isn't a prefix of the reply: the reply only holds the text
        // after the last tool call. Close the stream and any tool row still
        // marked running, instead of asking the daemon to replay the turn.
        if input.closesTurn,
           let turnID = input.turnID, !turnID.isEmpty,
           state.streamingTurnIDByAgent[bucket] == turnID {
            clearStreaming(bucket, in: &state)
            for i in state.entries.indices where state.entries[i].eventType == "tool_use"
                && !state.entries[i].isComplete
                && state.entries[i].turnID == turnID
                && (state.entries[i].senderActorID ?? "") == bucket {
                state.entries[i].isComplete = true
            }
            return .entriesChanged
        }

        // Residual-streaming cleanup. Cold-start `start()` may have restored
        // `streamingAgentSet[bucket]` from a `stop()`-saved synthetic
        // incomplete output — but if Supabase shows the turn already
        // completed (because the daemon finished while iOS was disconnected),
        // the typing indicator is stale and must come down. Clear when the
        // incoming history row is a complete `output` for this bucket AND
        // the streaming partial we saved is a prefix of the finalized text
        // (so we don't wipe an unrelated, genuinely-active stream for the
        // same agent that just happened to land mid-seed).
        let partial = state.streamingTextByAgent[bucket] ?? ""
        // Only clear when our saved partial is consistent with the
        // finalized text — empty partial (no active stream) or a
        // prefix of the completed content. Otherwise leave streaming
        // state alone; it belongs to an unrelated active turn.
        if partial.isEmpty || input.content.hasPrefix(partial) {
            clearStreaming(bucket, in: &state)
        }
        return effect
    }

    private static func clearStreaming(_ bucket: String, in state: inout TimelineState) {
        state.streamingAgentSet.remove(bucket)
        state.streamingTextByAgent[bucket] = nil
        state.streamingModelByAgent[bucket] = nil
        state.streamingTurnIDByAgent[bucket] = nil
    }

    private static func applyHistoryRow(_ input: HistoryInput, to state: inout TimelineState) -> TimelineReducerEffect {
        // Attachments reach the timeline only on a history row: the optimistic
        // prompt and the live ACP reply have no attachment channel of their
        // own. Every merge branch below is a row that came from somewhere
        // else, so each one adopts them. Backfill, never overwrite — a
        // re-seed must not churn a row that already has them.
        func adoptAttachments(_ idx: Int) {
            guard !input.attachments.isEmpty, state.entries[idx].attachments.isEmpty else { return }
            state.entries[idx].attachments = input.attachments
        }

        // Identity dedupe by supabaseMessageID.
        if let idx = state.entries.firstIndex(where: { $0.supabaseMessageID == input.supabaseMessageID }) {
            if state.entries[idx].timestamp != input.createdAt {
                state.entries[idx].timestamp = input.createdAt
            }
            if state.entries[idx].model == nil {
                state.entries[idx].model = input.model
            }
            if state.entries[idx].turnID == nil {
                state.entries[idx].turnID = input.turnID
            }
            adoptAttachments(idx)
            return .entriesChanged
        }
        let eventType: String = input.kind == .output ? "output" : "user_prompt"

        // Local outbox merge: iOS uses the Supabase message id as the
        // outbox message id for the optimistic prompt row. When the
        // history seed returns that row, merge by this stable id before
        // falling back to content matching. This avoids collapsing the
        // wrong bubble when the user sends the same text twice.
        if let idx = state.entries.firstIndex(where: {
            $0.outboxMessageID == input.supabaseMessageID || $0.id == input.supabaseMessageID
        }) {
            state.entries[idx].supabaseMessageID = input.supabaseMessageID
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            if state.entries[idx].timestamp > input.createdAt {
                state.entries[idx].timestamp = input.createdAt
            }
            adoptAttachments(idx)
            return .entriesChanged
        }

        // Cross-source dedupe: if the same output content already exists
        // for the same agent (live stream / daemon history finalised before
        // the Supabase history seed ran, or Supabase returned another row id
        // for the same persisted reply), keep one bubble. User prompts stay
        // on the stricter nil-id path below so sending the same text twice
        // does not collapse separate human messages.
        if eventType == "output",
           let idx = state.entries.firstIndex(where: {
               $0.eventType == eventType
                   && ($0.senderActorID ?? "") == (input.senderActorID ?? "")
                   && $0.text == input.content
           }) {
            if state.entries[idx].supabaseMessageID == nil {
                state.entries[idx].supabaseMessageID = input.supabaseMessageID
            }
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            adoptAttachments(idx)
            return .entriesChanged
        }

        // Prefix upgrade: a live/status flush can persist a completed
        // output fragment before the Supabase history seed returns the
        // authoritative full reply. The fragment has no Supabase id or
        // turn id, and its local timestamp is later than the persisted
        // message timestamp. Replace it in place instead of rendering both.
        if eventType == "output",
           let idx = state.entries.firstIndex(where: {
               guard $0.eventType == "output",
                     $0.supabaseMessageID == nil,
                     $0.turnID == nil,
                     ($0.senderActorID ?? "") == (input.senderActorID ?? ""),
                     let text = $0.text,
                     !text.isEmpty,
                     text.count < input.content.count,
                     input.content.hasPrefix(text),
                     $0.timestamp >= input.createdAt
               else { return false }
               return true
           }) {
            state.entries[idx].text = input.content
            state.entries[idx].timestamp = input.createdAt
            state.entries[idx].supabaseMessageID = input.supabaseMessageID
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            state.entries[idx].turnID = input.turnID
            adoptAttachments(idx)
            return .entriesChanged
        }

        // Conservative prompt dedupe: if the same content already exists
        // without a Supabase id (live stream finalised before the history
        // seed ran), backfill the id rather than append a duplicate.
        if let idx = state.entries.firstIndex(where: {
            $0.supabaseMessageID == nil
                && $0.eventType == eventType
                && $0.text == input.content
        }) {
            state.entries[idx].supabaseMessageID = input.supabaseMessageID
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            if state.entries[idx].timestamp > input.createdAt {
                state.entries[idx].timestamp = input.createdAt
            }
            adoptAttachments(idx)
            return .entriesChanged
        }

        // Multi-segment turns stay separate. The daemon's turn_aggregator
        // flushes the reply buffer as its own AgentReply row whenever a
        // ToolUse cuts the stream mid-turn, so a single turnID can map
        // to multiple Supabase rows with different text content. The
        // chat feed collapses these back into one bubble via
        // `buildFeedItems`'s completedTurnIndexByKey, and the message-
        // detail view sorts them chronologically alongside the tool
        // rows; concatenating into a single entry here would discard
        // the per-segment timestamps the detail view needs.

        state.entries.append(TimelineEntry(
            id: UUID().uuidString,
            sequence: UInt64(max(0, input.sequence)),
            eventType: eventType,
            text: input.content,
            isComplete: true,
            senderActorID: input.senderActorID,
            timestamp: input.createdAt,
            model: input.model,
            supabaseMessageID: input.supabaseMessageID,
            turnID: input.turnID,
            attachments: input.attachments
        ))
        // History entries land sorted by createdAt; keep the array
        // ordered so feed-rendering downstream stays consistent.
        state.entries.sort { $0.timestamp < $1.timestamp }
        return .entriesChanged
    }

    // MARK: - .localPrompt

    @discardableResult
    static func applyLocal(_ input: LocalPromptInput, to state: inout TimelineState) -> TimelineReducerEffect {
        // Re-feeding the same clientID is a no-op.
        if state.entries.contains(where: { $0.clientID == input.clientID }) { return .noop }
        state.entries.append(TimelineEntry(
            id: UUID().uuidString,
            eventType: "user_prompt",
            text: input.content,
            isComplete: true,
            senderActorID: input.senderActorID,
            timestamp: input.createdAt,
            clientID: input.clientID,
            // clientID doubles as the outboxMessageID so the chat
            // view's status-dot accessory keeps working after the
            // reducer takes over from the inline handler.
            outboxMessageID: input.clientID
        ))
        return .entriesChanged
    }

    // MARK: - .permissionResolution

    @discardableResult
    static func applyPermission(_ input: PermissionResolutionInput, to state: inout TimelineState) -> TimelineReducerEffect {
        // Find the matching permission_request entry; drop silently
        // if there's no match (out-of-order arrival).
        guard let idx = state.entries.firstIndex(where: {
            $0.eventType == "permission_request" && $0.toolID == input.requestID
        }) else { return .noop }
        state.entries[idx].isComplete = true
        state.entries[idx].success = input.granted
        return .entriesChanged
    }

    // MARK: - Helpers

    private static func makeEntry(
        sequence: UInt64,
        eventType: String,
        text: String? = nil,
        toolID: String? = nil,
        toolName: String? = nil,
        senderActorID: String?,
        timestamp: Date,
        model: String? = nil,
        isComplete: Bool = false,
        success: Bool? = nil,
        turnID: String? = nil
    ) -> TimelineEntry {
        TimelineEntry(
            id: UUID().uuidString,
            sequence: sequence,
            eventType: eventType,
            text: text,
            toolID: toolID,
            toolName: toolName,
            isComplete: isComplete,
            success: success,
            senderActorID: senderActorID,
            timestamp: timestamp,
            model: model,
            turnID: turnID
        )
    }

    /// First diff content block on a ToolUse/ToolResult envelope, or nil.
    /// ACP edit tools emit exactly one; extra blocks (text summaries) ride
    /// alongside and are already rendered via description/summary.
    private static func firstDiff(_ content: [Amux_AcpToolCallContent]) -> Amux_AcpToolCallDiff? {
        for item in content {
            if case .diff(let diff)? = item.payload { return diff }
        }
        return nil
    }

    private static func applyDiff(_ diff: Amux_AcpToolCallDiff, to entry: inout TimelineEntry) {
        entry.diffPath = diff.path
        entry.diffOldText = diff.hasOldText ? diff.oldText : nil
        entry.diffNewText = diff.newText
    }

    private static func incompleteOutputIndex(for bucket: String,
                                              in state: TimelineState) -> Int? {
        // Walk newest-first since incomplete outputs cluster near the
        // end; matches the production VM's hot-path optimization.
        var i = state.entries.count - 1
        while i >= 0 {
            let e = state.entries[i]
            if e.eventType == "output",
               !e.isComplete,
               (e.senderActorID ?? "") == bucket {
                return i
            }
            i -= 1
        }
        return nil
    }

    private static func outputCompleteIndex(for bucket: String,
                                            turnID: String,
                                            in state: TimelineState) -> Int? {
        // Walk newest-first — completed outputs land at the tail of the
        // turn's event group, and history replays target the most recent
        // turns first when the user reopens a stale session detail.
        var i = state.entries.count - 1
        while i >= 0 {
            let e = state.entries[i]
            if e.eventType == "output",
               e.isComplete,
               e.turnID == turnID,
               (e.senderActorID ?? "") == bucket {
                return i
            }
            i -= 1
        }
        return nil
    }
}
