import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

@MainActor
private struct TurnHistoryFetcher: ViewModifier {
    let viewModel: SessionDetailViewModel
    let route: TurnRoute
    @Environment(\.modelContext) private var modelContext

    func body(content: Content) -> some View {
        content.task(id: route.frozenTurnID) {
            // Load the pinned turn's thinking / tool calls / partial output:
            // its cloud trace (cached on disk after the first open), or the
            // daemon's recorded events when the turn has no trace. Active
            // streams already receive live deltas via MQTT.
            guard let turnID = route.frozenTurnID, !turnID.isEmpty else { return }
            await viewModel.loadTurnDetail(
                modelContext: modelContext,
                turnID: turnID,
                agentID: route.agentID
            )
        }
    }
}

/// Hashable handle for `.navigationDestination(for:)`. The active vs.
/// completed distinction is implicit — the destination view inspects the
/// view-model's current `feedItems` and renders whichever turn matches:
/// active stream takes priority, otherwise the most recent completed
/// turn for that agent. `frozenTurnID` lets a tap on a specific
/// completed-turn icon point back to that exact turn even when the
/// agent has run multiple later turns since.
public struct TurnRoute: Hashable {
    public let agentID: String
    /// Set when navigating from a completed-turn icon to pin to that
    /// specific turn id. Nil when navigating from an active stream — the
    /// destination resolves dynamically.
    public let frozenTurnID: String?

    public init(agentID: String, frozenTurnID: String? = nil) {
        self.agentID = agentID
        self.frozenTurnID = frozenTurnID
    }
}

enum StreamingDetailPresentation {
    /// A pinned route always represents an already-completed turn. Live
    /// buffers are keyed only by agent, so reading them from a pinned view
    /// can append a newer/stale turn below the historical final response and
    /// leave its typing indicator and stop button visible forever.
    static func followsLiveStream(for route: TurnRoute) -> Bool {
        route.frozenTurnID == nil
    }
}

/// Per-turn streaming detail view pushed from the chat list. Shows the
/// thinking / tool_use / tool_result events that produced the agent's
/// reply, plus the live streaming text when the turn is still in flight.
/// Top-right toolbar holds a stop button while streaming; back is the
/// NavigationStack default.
public struct StreamingDetailView: View {
    let route: TurnRoute
    @Bindable var viewModel: SessionDetailViewModel
    @State private var todoDockCollapsed = true
    @Query(sort: \CachedActor.displayName) private var cachedActors: [CachedActor]
    private var cachedActorMap: CachedActorMap {
        CachedActorMap(nameByActorID: Dictionary(uniqueKeysWithValues: cachedActors.map { ($0.actorId, $0.displayName) }))
    }
    /// Snapshot of the resolved turn, rebuilt only when feedItems changes
    /// (not on every streaming-text delta). During streaming, feedItems is
    /// stable between tool_use/thinking events so the sort + feedItems walk
    /// inside `computeResolved()` fires far less often than the body itself.
    @State private var resolvedSnapshot: (events: [AgentEvent], isActive: Bool, agentName: String) = ([], false, "")
    /// Last feedItems fingerprint we used to build `resolvedSnapshot`.
    @State private var lastFeedFingerprint = ""
    @State private var fullscreenAttachment: MessageAttachment?

    /// Every file the turn produced, in the order its events did, with the
    /// same attachment never listed twice — a multi-segment turn can repeat
    /// one across its reply rows.
    private var turnAttachments: [MessageAttachment] {
        var seen = Set<String>()
        return resolvedSnapshot.events
            .flatMap(\.attachments)
            .filter { seen.insert($0.identity).inserted }
    }

    public init(route: TurnRoute, viewModel: SessionDetailViewModel) {
        self.route = route
        self.viewModel = viewModel
    }

    private var planUpdateText: String? {
        viewModel.activePlanSnapshots.first(where: { $0.agentID == route.agentID })?.text
    }

    /// Build a fingerprint for the current feedItems that changes when the
    /// content relevant to this view changes (new events in this turn, or
    /// active→completed transition). Used to invalidate `resolvedSnapshot`.
    private var feedFingerprint: String {
        let items = viewModel.feedItems
        // Capture turn-relevant item count + total runtime event count so
        // a new tool_use inside an active stream is detected even though
        // the number of FeedItems is unchanged.
        // Also capture lastEventID so that requestTurnHistory insertions
        // that change event ordering (same count, different last event)
        // are detected and resolvedSnapshot is properly invalidated.
        var turnEventCount = 0
        var lastEventID = ""
        for item in items {
            switch item {
            case .activeStream(_, let agentID, let runtime) where agentID == route.agentID:
                turnEventCount = runtime.count
                lastEventID = runtime.last?.id ?? ""
            case .completedTurn(let id, _, let finalEvent, let runtime)
                    where id == route.frozenTurnID || route.frozenTurnID == nil:
                turnEventCount = runtime.count
                lastEventID = finalEvent.id
            default: break
            }
        }
        // A trace arriving for the pinned turn replaces the local rows.
        let traceCount = route.frozenTurnID
            .flatMap { viewModel.loadedTurnTraces[$0]?.events.count } ?? -1
        return "\(items.count)-\(turnEventCount)-\(lastEventID)-\(traceCount)"
    }

    /// Compute resolved turn data fresh from feedItems. The result is sorted
    /// chronologically so text→tool→text turns display in the correct order.
    private func computeResolved() -> (events: [AgentEvent], isActive: Bool, agentName: String) {
        if let pinned = route.frozenTurnID {
            // Local rows for this exact turn, gathered first: they are both
            // the fallback when the cloud has no trace and the tail spliced
            // onto one that was trimmed.
            var localEvents: [AgentEvent] = []
            var localAgentID = route.agentID
            for item in viewModel.feedItems {
                if case .completedTurn(let id, let agentID, let final, let runtime) = item,
                   id == pinned {
                    localEvents = runtime + [final]
                    localAgentID = agentID
                    break
                }
            }
            if let trace = viewModel.loadedTurnTraces[pinned], !trace.events.isEmpty {
                return (
                    trace.merged(withLocal: localEvents),
                    false,
                    agentNameFor(localAgentID)
                )
            }
            if !localEvents.isEmpty {
                return (chronologicallySorted(localEvents), false, agentNameFor(localAgentID))
            }
        }
        for item in viewModel.feedItems {
            if case .activeStream(_, let agentID, let runtime) = item,
               agentID == route.agentID {
                return (chronologicallySorted(runtime), true, agentNameFor(agentID))
            }
        }
        for item in viewModel.feedItems.reversed() {
            if case .completedTurn(_, let agentID, let final, let runtime) = item,
               agentID == route.agentID {
                return (chronologicallySorted(runtime + [final]), false, agentNameFor(agentID))
            }
        }
        return ([], false, agentNameFor(route.agentID))
    }

    private func chronologicallySorted(_ events: [AgentEvent]) -> [AgentEvent] {
        events.sorted { lhs, rhs in
            if lhs.timestamp != rhs.timestamp { return lhs.timestamp < rhs.timestamp }
            if lhs.sequence != rhs.sequence { return lhs.sequence < rhs.sequence }
            return lhs.id < rhs.id
        }
    }

    private func agentNameFor(_ agentID: String) -> String {
        viewModel.memberSheetAgents.first(where: { $0.id == agentID })?.displayName
            ?? String(agentID.prefix(8))
    }

    /// Model display name for this turn — the model stamped on the
    /// latest event in the resolved snapshot that has one. Tool / status
    /// events are not model-attributable so we walk backward to find the
    /// most recent reply/thinking with a non-empty model id. nil if no
    /// event in the turn has a model (legacy rows, or the daemon hasn't
    /// stamped current_model yet).
    private func modelDisplayName(for events: [AgentEvent]) -> String? {
        guard let attachment = viewModel.attachment(forAgentActorID: route.agentID) else { return nil }
        for event in events.reversed() {
            if let name = event.modelDisplayName(via: attachment) {
                return name
            }
        }
        return nil
    }

    /// A quiet line under a pinned turn when there is less to show than the
    /// agent did: the trace hit its size budget, or neither the cloud nor the
    /// daemon had anything beyond the final reply.
    private func processNote(eventCount: Int) -> String? {
        guard let pinned = route.frozenTurnID else { return nil }
        if let dropped = viewModel.loadedTurnTraces[pinned]?.droppedEvents, dropped > 0 {
            return String(localized: "\(dropped) more events weren't recorded")
        }
        if viewModel.turnTraceFallbackTurnIDs.contains(pinned),
           !viewModel.isSyncing,
           eventCount <= 1 {
            return String(localized: "No process details are available for this turn")
        }
        return nil
    }

    public var body: some View {
        let snapshot = resolvedSnapshot
        let followsLiveStream = StreamingDetailPresentation.followsLiveStream(for: route)
        let liveText = followsLiveStream
            ? (viewModel.streamingTextByAgent[route.agentID] ?? "")
            : ""
        let stillStreaming = followsLiveStream
            && viewModel.streamingAgentSet.contains(route.agentID)

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if snapshot.events.isEmpty && liveText.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 36))
                                .foregroundStyle(.quaternary)
                            Text("Waiting for the agent…")
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 60)
                    }

                    ForEach(snapshot.events, id: \.id) { event in
                        EventBubbleView(
                            event: event,
                            runtime: viewModel.attachment(forAgentActorID: route.agentID),
                            onGrant: { id, agentID in Task { try? await viewModel.grantPermission(requestId: id, agentActorID: agentID ?? route.agentID) } },
                            onDeny: { id, agentID in Task { try? await viewModel.denyPermission(requestId: id, agentActorID: agentID ?? route.agentID) } },
                            onGrantOption: { id, optionID, agentID in
                                Task { try? await viewModel.grantPermission(requestId: id, agentActorID: agentID ?? route.agentID, optionID: optionID) }
                            },
                            permissionOptions: { viewModel.permissionOptions(for: $0) },
                            // The nav-bar title already shows
                            // "{agent} · {model}" for the whole turn;
                            // suppressing the per-bubble caption keeps
                            // this view's left margin clean and avoids
                            // repeating identity on every assistant row.
                            showsAssistantHeader: false,
                            // Collected below instead, so a turn's files sit
                            // together at the end rather than scattered
                            // through its reply segments.
                            showsAttachments: false,
                            actorMap: cachedActorMap
                        )
                        .id(event.id)
                    }

                    if stillStreaming, !liveText.isEmpty {
                        StreamingTextView(content: liveText)
                            .id("detail-streaming")
                    }

                    if snapshot.isActive || stillStreaming {
                        TypingIndicatorView()
                            .id("detail-typing")
                    }

                    // Everything the turn produced, at the end of the
                    // process — the natural place to look for what came
                    // out of it once you've read how it got there.
                    if !turnAttachments.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(verbatim: "FILES")
                                .font(.system(size: 9, design: .monospaced))
                                .tracking(2)
                                .foregroundStyle(Color.amux.slate)
                            MessageAttachmentsView(
                                attachments: turnAttachments,
                                onTapImage: { fullscreenAttachment = $0 }
                            )
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .id("detail-attachments")
                    }

                    if let note = processNote(eventCount: snapshot.events.count) {
                        Text(note)
                            .font(.caption)
                            .foregroundStyle(Color.amux.slate)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 16)
                            .padding(.top, 12)
                    }

                    Color.clear.frame(height: 16).id("detail-bottom")
                }
                .padding(.top, 8)
            }
            // Start long turns at the bottom without bottom-aligning short
            // turns inside the viewport.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onChange(of: snapshot.events.count) {
                // New event arrived in this turn — gentle animation to anchor.
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("detail-bottom", anchor: .bottom) }
            }
            .onChange(of: liveText) { _, _ in
                // Per-token scroll: no animation. The previous withAnimation
                // layered a new 0.2s easeOut on every single token, compounding
                // layout work at 30–60 deltas/sec. Plain scrollTo is instant
                // and SwiftUI's scroll view still animates the position change
                // smoothly via its own momentum tracking.
                guard stillStreaming else { return }
                proxy.scrollTo("detail-bottom", anchor: .bottom)
            }
        }
        .onAppear {
            let fp = feedFingerprint
            lastFeedFingerprint = fp
            resolvedSnapshot = computeResolved()
        }
        .onChange(of: feedFingerprint) { _, newFP in
            guard newFP != lastFeedFingerprint else { return }
            lastFeedFingerprint = newFP
            resolvedSnapshot = computeResolved()
        }
        .fullScreenCover(item: $fullscreenAttachment) { attachment in
            FullScreenAttachmentViewer(attachment: attachment)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let text = planUpdateText {
                TodoDockView(text: text, isCollapsed: $todoDockCollapsed)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Center-stack: agent name on the headline line, model
            // underneath as a caption. Replaces the old single-line
            // `.navigationTitle(agentName)` so the model is visible
            // for the whole detail view without re-printing per bubble.
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(snapshot.agentName)
                        .font(.headline)
                        .lineLimit(1)
                    if let model = modelDisplayName(for: snapshot.events) {
                        Text(model)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            if snapshot.isActive || stillStreaming {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) {
                        viewModel.interruptAgent(route.agentID)
                    } label: {
                        Image(systemName: "stop.fill")
                            .foregroundStyle(Color.amux.cinnabarDeep)
                    }
                    .accessibilityLabel("Interrupt agent")
                }
            }
        }
        .modifier(TurnHistoryFetcher(viewModel: viewModel, route: route))
    }
}
