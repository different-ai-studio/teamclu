import Foundation
import SwiftData

/// Sync layer between the pure-value `TimelineState` (driven by the
/// reducer) and the SwiftData-backed `[AgentEvent]` the view layer
/// renders.
///
/// Phase 4 main strategy: `ChatTimelineReducer` is the source of truth
/// for what the timeline contains; `AgentEvent` rows are projected from
/// it so the SwiftUI view + crash-recovery persistence keep working
/// without rewriting the view bindings.
///
/// ## Diff semantics
///
/// Each `sync(state:, into:, modelContext:)` call computes the diff
/// between `state.entries` and the current SwiftData rows in `events`:
///
/// - Entries new to the state → insert a fresh `AgentEvent`, stamping
///   `agentEvent.id` from `entry.id` so future diffs match.
/// - Entries that match an existing row by id → update mutable fields
///   in place (text, isComplete, success, model, supabaseMessageId).
/// - Rows no longer in state → delete the SwiftData object and drop
///   from `events`.
///
/// The function returns `true` iff the projection mutated SwiftData, so
/// callers can avoid unnecessary `recomputeGroups()` work on no-op
/// applies (e.g. a streaming delta only mutates the reducer's per-agent
/// buffer, not `state.entries`).
public enum TimelineSwiftDataSync {

    @MainActor
    @discardableResult
    public static func sync(
        state: TimelineState,
        into events: inout [AgentEvent],
        agentId scope: String,
        modelContext: ModelContext
    ) -> Bool {
        var dirty = false
        let entriesByID = Dictionary(uniqueKeysWithValues: state.entries.map { ($0.id, $0) })
        let eventsByID = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })

        // Remove SwiftData rows whose id has fallen out of state.entries.
        // This covers the reducer's "drop synthetic stop()-saved entry"
        // path on the first streaming delta.
        for event in events where entriesByID[event.id] == nil {
            modelContext.delete(event)
            dirty = true
        }
        events.removeAll { entriesByID[$0.id] == nil }

        // Insert + update.
        var nextEvents: [AgentEvent] = []
        nextEvents.reserveCapacity(state.entries.count)
        for entry in state.entries {
            if let existing = eventsByID[entry.id] {
                if apply(entry: entry, to: existing) { dirty = true }
                nextEvents.append(existing)
            } else {
                let row = makeAgentEvent(from: entry, agentId: scope)
                modelContext.insert(row)
                nextEvents.append(row)
                dirty = true
            }
        }
        events = nextEvents
        if dirty { try? modelContext.save() }
        return dirty
    }

    // MARK: - Field-by-field projection

    /// True when any field on `event` was updated to match `entry`.
    private static func apply(entry: TimelineEntry, to event: AgentEvent) -> Bool {
        var changed = false
        if event.text != entry.text { event.text = entry.text; changed = true }
        if event.isComplete != entry.isComplete { event.isComplete = entry.isComplete; changed = true }
        if event.success != entry.success { event.success = entry.success; changed = true }
        if event.model != entry.model { event.model = entry.model; changed = true }
        if event.supabaseMessageId != entry.supabaseMessageID {
            event.supabaseMessageId = entry.supabaseMessageID; changed = true
        }
        if event.senderActorID != entry.senderActorID {
            event.senderActorID = entry.senderActorID; changed = true
        }
        if event.toolId != entry.toolID { event.toolId = entry.toolID; changed = true }
        if event.toolName != entry.toolName { event.toolName = entry.toolName; changed = true }
        if event.timestamp != entry.timestamp { event.timestamp = entry.timestamp; changed = true }
        if event.outboxMessageID != entry.outboxMessageID {
            event.outboxMessageID = entry.outboxMessageID; changed = true
        }
        if event.turnID != entry.turnID { event.turnID = entry.turnID; changed = true }
        if event.resultSummary != entry.resultSummary {
            event.resultSummary = entry.resultSummary; changed = true
        }
        if event.diffPath != entry.diffPath { event.diffPath = entry.diffPath; changed = true }
        if event.diffOldText != entry.diffOldText { event.diffOldText = entry.diffOldText; changed = true }
        if event.diffNewText != entry.diffNewText { event.diffNewText = entry.diffNewText; changed = true }
        // Compared as the decoded value, not the JSON: re-encoding can reorder
        // keys and would mark every row dirty on every sync.
        if event.attachments != entry.attachments {
            event.attachments = entry.attachments; changed = true
        }
        return changed
    }

    static func makeAgentEvent(from entry: TimelineEntry, agentId: String) -> AgentEvent {
        let event = AgentEvent(agentId: agentId, sequence: Int(entry.sequence), eventType: entry.eventType)
        event.id = entry.id
        event.text = entry.text
        event.toolId = entry.toolID
        event.toolName = entry.toolName
        event.isComplete = entry.isComplete
        event.success = entry.success
        event.senderActorID = entry.senderActorID
        event.timestamp = entry.timestamp
        event.model = entry.model
        event.supabaseMessageId = entry.supabaseMessageID
        event.outboxMessageID = entry.outboxMessageID
        event.turnID = entry.turnID
        event.resultSummary = entry.resultSummary
        event.diffPath = entry.diffPath
        event.diffOldText = entry.diffOldText
        event.diffNewText = entry.diffNewText
        event.attachments = entry.attachments
        return event
    }

    /// The inverse of `makeAgentEvent`, used to rebuild the reducer state
    /// from stored rows. Every field `apply(entry:to:)` writes must be read
    /// here: the next sync writes the entry back over the row, so a field
    /// left out is erased from SwiftData.
    static func makeEntry(from event: AgentEvent) -> TimelineEntry {
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
            turnID: event.turnID,
            resultSummary: event.resultSummary,
            diffPath: event.diffPath,
            diffOldText: event.diffOldText,
            diffNewText: event.diffNewText,
            attachments: event.attachments
        )
    }
}
