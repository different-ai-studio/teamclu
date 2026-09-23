import SwiftUI
import SwiftData
import UIKit
import AMUXCore
import AMUXSharedUI

// MARK: - SessionDetailView (iMessage-style chat detail)

public struct SessionDetailView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel: SessionDetailViewModel
    /// Single actor-directory query shared by all EventBubbleView instances
    /// in this session, replacing per-row @Query registrations.
    @Query(sort: \CachedActor.displayName) private var cachedActors: [CachedActor]
    private var cachedActorMap: CachedActorMap {
        CachedActorMap(nameByActorID: Dictionary(uniqueKeysWithValues: cachedActors.map { ($0.actorId, $0.displayName) }))
    }
    @State private var promptText = ""
    /// Composer focus lives here, not in `SessionComposer`, so the transcript
    /// can give the keyboard's space back to the messages on scroll or tap.
    @FocusState private var composerFocused: Bool
    @State private var attachments: [URL] = []
    @State private var voiceRecorder = VoiceRecorder(contextualStrings: [
        "Claude", "Claude Code", "Sonnet", "Opus", "Haiku",
        "MQTT", "protobuf", "SwiftUI", "SwiftData",
        "agent", "daemon", "worktree", "workspace",
        "commit", "push", "merge", "pull request",
        "API", "JSON", "YAML", "REST", "gRPC",
    ])
    @State private var isMemberSheetPresented: Bool = false
    @State private var isAddAgentSheetPresented: Bool = false
    @State private var isAddMemberSheetPresented: Bool = false
    @State private var muted = false
    @State private var isPlansPanelPresented: Bool = false
    @State private var plansPageIndex: Int = 0
    @State private var hasAutoOpenedPlans: Bool = false
    @State private var isInitialFeedVisible: Bool = false
    @State private var initialAutoScrollSettled: Bool = false
    @State private var isAtBottom: Bool = true
    @State private var scrollProxy: ScrollViewProxy? = nil
    /// User-prompt bubble currently being edited (drives the edit sheet).
    @State private var editingEvent: AgentEvent?
    /// User-prompt bubble pending delete confirmation (drives the dialog).
    @State private var pendingDeleteEvent: AgentEvent?
    private let nearBottomThreshold: CGFloat = 80
    /// Height the keyboard currently takes off the bottom of the screen — the
    /// full software keyboard, or just the shortcut bar when a hardware one is
    /// attached. Either shape means the system has handed the home-indicator
    /// reserve to the keyboard, which is what the composer's resting gap turns
    /// on. Composer focus is the wrong predicate: with a hardware keyboard the
    /// field takes focus and nothing appears.
    @State private var keyboardInset: CGFloat = 0
    /// How far the resting composer is pulled back into the home-indicator
    /// reserve. That reserve (34pt on current iPhones) plus the composer's own
    /// 8pt stacks to 42pt off the screen edge — a band of empty paper next to
    /// the 22pt the tab bar's pill sits at elsewhere in the app. Taking 12pt
    /// back lands on the same 22pt. Where the reserve is shorter the card just
    /// ends up nearer the edge, never past it.
    private static let composerRestingBottomPullback: CGFloat = -12
    /// Cached TeamcluService used to lazily build the OutboxSender once
    /// the modelContext (and therefore its container) is available.
    private let pendingTeamcluService: TeamcluService?
    private let pushPrefs: (any PushPreferencesAPI)?
    /// Preferred mute backend — the team-runtime store keeps the session
    /// list's muted set in sync with toggles made here. `pushPrefs` stays
    /// as the fallback for hosts that don't carry a team runtime.
    private let notificationPrefsStore: NotificationPrefsStore?
    private let workspacesRepository: (any WorkspaceRepository)?

    let connectedAgentsStore: ConnectedAgentsStore?
    /// Forwarded to AddMemberSheet's picker so it refreshes presence.
    let actorStore: ActorStore?
    let agentPresenceStore: AgentPresenceStore?

    public init(session: Session, mqtt: MQTTService, hub: MQTTMessageHub, peerId: String,
                teamcluService: TeamcluService?,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                messagesRepository: (any MessagesRepository)? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                sessionsRepository: (any SessionRepository)? = nil,
                pushPrefs: (any PushPreferencesAPI)? = nil,
                notificationPrefsStore: NotificationPrefsStore? = nil,
                actorStore: ActorStore? = nil,
                agentPresenceStore: AgentPresenceStore? = nil) {
        _viewModel = State(initialValue: SessionDetailViewModel(
            runtime: nil, mqtt: mqtt, hub: hub, teamID: session.teamId,
            peerId: peerId, session: session,
            teamcluService: teamcluService,
            connectedAgentsStore: connectedAgentsStore,
            sessionsRepository: sessionsRepository,
            messagesRepository: messagesRepository,
            workspacesRepository: workspacesRepository))
        self.connectedAgentsStore = connectedAgentsStore
        self.actorStore = actorStore
        self.agentPresenceStore = agentPresenceStore
        self.pendingTeamcluService = teamcluService
        self.pushPrefs = pushPrefs
        self.notificationPrefsStore = notificationPrefsStore
        self.workspacesRepository = workspacesRepository
    }


    // `body` is a long modifier chain over three pieces. They live here
    // rather than inline because inline they were one expression for the
    // type-checker to solve, and it took 7.9s on a fast machine — past
    // the compiler's budget on CI, where the archive failed outright with
    // "unable to type-check this expression in reasonable time".

    @ViewBuilder
    private var daemonOfflineBanner: some View {
        if !viewModel.isDaemonOnline {
            HStack(spacing: 6) {
                Image(systemName: "wifi.slash").font(.caption)
                Text("Daemon offline").font(.caption).fontWeight(.medium)
            }
            .foregroundStyle(Color.amux.basalt)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            // Hai banners stay quiet — Pebble fill instead of system
            // orange. Vermillion is rationed for active session sends.
            .background(Capsule().fill(Color.amux.pebble.opacity(0.7)))
            .overlay(Capsule().stroke(Color.amux.hairline, lineWidth: 0.5))
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private var sendErrorBanner: some View {
        if let sendError = viewModel.sendErrorMessage {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").font(.caption)
                Text(sendError).font(.caption).fontWeight(.medium)
            }
            .foregroundStyle(Color.amux.cinnabarDeep)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            // Send-error uses CinnabarDeep tint on a soft fill; matches
            // the destructive accent everywhere else (cf. Remove buttons).
            .background(Capsule().fill(Color.amux.cinnabarDeep.opacity(0.10)))
            .overlay(Capsule().stroke(Color.amux.cinnabarDeep.opacity(0.20), lineWidth: 0.5))
            .padding(.vertical, 4)
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if viewModel.events.isEmpty && viewModel.streamingAgentSet.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 40))
                                .foregroundStyle(.quaternary)
                            Text("No messages yet")
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 60)
                    }

                    ForEach(viewModel.feedItems) { item in
                        feedItemRow(item)
                            .id(item.id)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("session-detail-bottom")
                }
                .padding(.top, 8)
            }
            .id(viewModel.hasLoadedInitialFeed)
            .opacity(isInitialFeedVisible ? 1 : 0)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .task(id: viewModel.hasLoadedInitialFeed) {
                guard viewModel.hasLoadedInitialFeed, !isInitialFeedVisible else { return }
                initialAutoScrollSettled = false
                await Task.yield()
                proxy.scrollTo("session-detail-bottom", anchor: .bottom)
                await Task.yield()
                isInitialFeedVisible = true
                try? await Task.sleep(for: .milliseconds(1_200))
                proxy.scrollTo("session-detail-bottom", anchor: .bottom)
                initialAutoScrollSettled = true
            }
            .task(id: initialFeedScrollKey) {
                guard viewModel.hasLoadedInitialFeed, !initialAutoScrollSettled else { return }
                await Task.yield()
                proxy.scrollTo("session-detail-bottom", anchor: .bottom)
            }
            // Store the proxy so the composer's onSend callback (inside
            // safeAreaInset, outside this ScrollViewReader scope) can
            // programmatically scroll to bottom after the user sends.
            .onAppear { scrollProxy = proxy }
            // Track whether the user is near the bottom so incoming
            // messages don't hijack the scroll position while they are
            // browsing history.
            .onScrollGeometryChange(for: ScrollBottomMetrics.self) { geo in
                // `contentSize` excludes the bottom inset that the
                // composer's `safeAreaInset` adds, but `visibleRect`
                // includes it, so subtracting the two directly reported
                // ~116pt short of the bottom while sitting exactly at it —
                // which kept `isAtBottom` permanently false.
                ScrollBottomMetrics(
                    distanceFromBottom: (geo.contentSize.height + geo.contentInsets.bottom)
                        - geo.visibleRect.maxY,
                    viewportHeight: geo.containerSize.height,
                    bottomInset: geo.contentInsets.bottom
                )
            } action: { old, new in
                // A viewport resize — the keyboard opening, the composer
                // growing a line — moves the bottom without the user
                // having scrolled, and arrives *before* the keyboard
                // notification does. Don't let it rewrite the flag; take
                // it as the cue to re-pin instead, so someone reading the
                // newest message keeps it in view rather than losing it
                // behind the composer. Someone parked mid-history stays
                // parked.
                guard new.viewportHeight == old.viewportHeight,
                      new.bottomInset == old.bottomInset
                else {
                    if isAtBottom { scrollToBottom() }
                    return
                }
                isAtBottom = new.distanceFromBottom < nearBottomThreshold
            }
            // Follow the bottom whenever the feed grows after the initial
            // settle. `.defaultScrollAnchor(.bottom, for: .initialOffset)`
            // only governs first paint, so without this the just-sent
            // message lands beneath the composer's safeAreaInset and the
            // user has to scroll manually to see it.
            .onChange(of: viewModel.feedItems.count) { oldCount, newCount in
                guard initialAutoScrollSettled, newCount > oldCount, isAtBottom else { return }
                Task { @MainActor in
                    await Task.yield()
                    withAnimation(AMUXAnimation.fast) {
                        proxy.scrollTo("session-detail-bottom", anchor: .bottom)
                    }
                }
            }
            // Any scroll on the chat surface dismisses the keyboard.
            // .interactively (iMessage-style finger-tracks-keyboard)
            // got swallowed by the composer's nested TextField scroll
            // and the SafeAreaInset hosting it; .immediately is more
            // robust and matches the user's expectation that pulling
            // the chat reveals more chat.
            .scrollDismissesKeyboard(.immediately)
            // …but that modifier only resigns the responder; the
            // composer's `@FocusState` is hoisted here and lives in the
            // bottom safeAreaInset, outside this ScrollView, so it can
            // re-raise the keyboard on the next layout pass. Clear it
            // explicitly. `.tracking`/`.interacting` are the finger-driven
            // phases — `.animating` is excluded so the auto-scroll that
            // follows an incoming message never steals focus mid-typing.
            .onScrollPhaseChange { _, phase in
                guard composerFocused, phase == .tracking || phase == .interacting else { return }
                composerFocused = false
            }
            // Tapping anywhere in the transcript does the same. Simultaneous
            // so bubble buttons, disclosure rows and context menus still fire.
            .simultaneousGesture(
                TapGesture().onEnded {
                    if composerFocused { composerFocused = false }
                }
            )
        }
    }


    @ToolbarContentBuilder
    private var sessionToolbar: some ToolbarContent {
            ToolbarItem(placement: .topBarTrailing) {
                if !viewModel.activePlanSnapshots.isEmpty {
                    Button {
                        withAnimation(AMUXAnimation.fast) {
                            isPlansPanelPresented.toggle()
                        }
                        persistPlansPanelState(isPlansPanelPresented)
                    } label: {
                        Image(systemName: "list.bullet.clipboard")
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(Color.amux.cinnabar)
                    }
                    .accessibilityLabel("Plans")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        isMemberSheetPresented = true
                    } label: {
                        Label("Members", systemImage: "person.2")
                    }
                    if notificationPrefsStore != nil || pushPrefs != nil {
                        Button {
                            Task {
                                let sessionID = viewModel.session?.sessionId ?? ""
                                if let store = notificationPrefsStore {
                                    await store.toggleMute(sessionID: sessionID)
                                    muted = store.isMuted(sessionID)
                                } else {
                                    let next = !muted
                                    muted = next
                                    try? await pushPrefs?.setSessionMuted(sessionID: sessionID, muted: next)
                                }
                            }
                        } label: {
                            Label(
                                muted ? "Unmute notifications" : "Mute notifications",
                                systemImage: muted ? "bell" : "bell.slash"
                            )
                        }
                    }
                    if let session = viewModel.session {
                        // Session-level "full access": the client answers
                        // permission requests on the user's behalf
                        // (allow-once each time). Local to this device,
                        // mirroring the desktop's per-session mode.
                        Button {
                            session.autoApprovePermissions.toggle()
                            try? modelContext.save()
                        } label: {
                            Label(
                                session.autoApprovePermissions
                                    ? "Ask before running tools"
                                    : "Auto-approve permissions",
                                systemImage: session.autoApprovePermissions
                                    ? "hand.raised"
                                    : "checkmark.shield"
                            )
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Session options")
                .task {
                    let sessionID = viewModel.session?.sessionId ?? ""
                    guard !sessionID.isEmpty else { return }
                    if let store = notificationPrefsStore {
                        muted = store.isMuted(sessionID)
                    } else if let api = pushPrefs {
                        muted = (try? await api.isSessionMuted(sessionID: sessionID)) ?? false
                    }
                }
            }
    }

    /// The bottom bar — the pending-question card, or the composer.
    @ViewBuilder
    private var bottomBar: some View {
            VStack(spacing: 0) {
                if let question = viewModel.pendingQuestions.first {
                    AcpQuestionCard(
                        pending: question,
                        onSubmit: { answers in
                            try await viewModel.answerQuestion(question, answers: answers)
                        },
                        onSkip: {
                            try await viewModel.answerQuestion(question, answers: [], reject: true)
                        }
                    )
                    .id(question.id)
                } else {
                    SessionComposer(
                    promptText: $promptText,
                    attachments: $attachments,
                    voiceRecorder: voiceRecorder,
                    availableCommands: viewModel.availableCommands,
                    availableMentions: mentionTargets(),
                    sessionID: viewModel.session?.sessionId ?? "",
                    teamID: viewModel.teamIDRef,
                    agentChips: viewModel.memberSheetAgents.map { a in
                        AgentChipBar.AgentChip(
                            id: a.id,
                            displayName: a.displayName,
                            lifecycleState: AgentChipBar.LifecycleChipState.fromCore(a.lifecycleState)
                        )
                    },
                    agentChipSelection: Binding(
                        get: { viewModel.agentChipSelection },
                        set: { viewModel.setAgentChipSelection($0) }
                    ),
                    streamingAgentIDs: viewModel.streamingAgentIDs,
                    onAgentInterrupt: { agentID in
                        viewModel.interruptAgent(agentID)
                    },
                    memberSheetAgents: viewModel.memberSheetAgents,
                    attachmentForAgent: viewModel.attachment(for:),
                    onApplyModelForAgent: { agent, modelID in
                        viewModel.setModel(forAgent: agent.id, model: modelID)
                    },
                    onSend: { attachmentURLs in
                        let text = promptText
                        let modelId = resolvedModelId
                        promptText = ""
                        attachments = []
                        // Snap to bottom when the user sends so the outbox
                        // message and the incoming reply are always visible,
                        // regardless of where they were scrolled to.
                        isAtBottom = true
                        withAnimation(AMUXAnimation.fast) {
                            scrollProxy?.scrollTo("session-detail-bottom", anchor: .bottom)
                        }
                        Task {
                            try? await viewModel.sendPrompt(text, modelId: modelId, attachmentURLs: attachmentURLs, modelContext: modelContext)
                        }
                    },
                    onAgentMention: { target in
                        viewModel.lightAgentChip(target.id)
                    },
                    inputFocused: $composerFocused
                    )
                }
            }
            // The gap under the composer card lives here rather than inside
            // the composer, because it is measured from two different things:
            // at rest from the screen edge, with the keyboard up from the
            // keyboard. `ignoresSafeArea` on inset content doesn't give the
            // reserve back — it stacks — so the resting case pulls into it.
            .padding(.bottom, keyboardInset > 0 ? 8 : Self.composerRestingBottomPullback)
    }

    // The chain below is split across three properties on purpose. As one
    // expression it took the type-checker 7.9s on a fast machine and blew
    // past the compiler's budget on CI, where the release archive failed
    // with "unable to type-check this expression in reasonable time". Each
    // `some View` boundary is a separate, much smaller problem to solve.

    /// The transcript and its navigation chrome.
    private var sessionSurface: some View {
        VStack(spacing: 0) {
            daemonOfflineBanner
            sendErrorBanner
            transcript
        }
        // Mist canvas — matches `agent-session.jsx`. Without an explicit
        // background, plain ScrollView falls back to systemBackground (stark
        // white), which breaks the seamless paper feel against the composer
        // and message bubbles.
        .background(Color.amux.mist)
        .navigationTitle(viewModel.sessionTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.amux.mist.opacity(0.85), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { sessionToolbar }
    }

    /// …plus everything that reacts to the view or the session changing.
    private var liveSessionSurface: some View {
        sessionSurface
        .onAppear {
            if let sid = viewModel.session?.sessionId {
                CurrentSessionFocus.sessionID = sid
            }
        }
        .onAppear {
            considerAutoOpeningPlans(count: viewModel.activePlanSnapshots.count)
        }
        .onChange(of: viewModel.activePlanSnapshots.count) { _, newCount in
            considerAutoOpeningPlans(count: newCount)
        }
        .onDisappear {
            if let sid = viewModel.session?.sessionId,
               CurrentSessionFocus.sessionID == sid {
                CurrentSessionFocus.sessionID = nil
            }
        }
        // Keep Plans as an overlay, not a top safe-area inset. Changing the
        // inset resizes ScrollView's viewport and makes the message list jump
        // when the toolbar button toggles the panel.
        .overlay(alignment: .top) {
            if isPlansPanelPresented {
                let snapshots = viewModel.activePlanSnapshots
                if !snapshots.isEmpty {
                    SessionPlansPanelView(
                        snapshots: snapshots,
                        pageIndex: $plansPageIndex
                    )
                }
            }
        }
        .safeAreaInset(edge: .bottom) { bottomBar }
        // `willChangeFrame` rather than `willShow`: with a hardware keyboard
        // attached the shortcut bar is already shown, so toggling the software
        // keyboard on only changes the frame and `willShow` never arrives. A
        // dismissal posts a change-frame too, carrying the off-screen frame,
        // but `willHide` follows it and settles the value at zero.
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
            keyboardInset = frame?.height ?? 0
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardInset = 0
        }
    }

    public var body: some View {
        liveSessionSurface
        .sheet(isPresented: $isMemberSheetPresented) {
            SessionMemberSheet(
                humans: viewModel.memberSheetHumans.map { h in
                    SessionMemberSheet.HumanRow(
                        id: h.id,
                        displayName: h.displayName,
                        isOnline: h.isOnline,
                        canRemove: h.canRemove
                    )
                },
                agents: viewModel.memberSheetAgents.map { row in
                    SessionMemberSheet.AgentRow(
                        id: row.id,
                        displayName: row.displayName,
                        workspacePath: row.workspacePath,
                        agentType: row.agentType,
                        lifecycleState: AgentChipBar.LifecycleChipState.fromCore(row.lifecycleState),
                        availableModels: row.availableModels,
                        currentModel: row.currentModel
                    )
                },
                onRemoveHuman: { viewModel.removeHuman($0) },
                onRestartAgent: { viewModel.restartAgent(forAgent: $0) },
                onChangeModel: { viewModel.setModel(forAgent: $0, model: $1) },
                onRemoveAgent: { viewModel.removeAgent($0) },
                onAddAgent: { isAddAgentSheetPresented = true },
                onAddMember: { isAddMemberSheetPresented = true }
            )
            .task { await viewModel.refreshMemberSheet() }
            .sheet(isPresented: $isAddAgentSheetPresented) {
                AddAgentSheet(
                    candidates: viewModel.candidatesForAddAgent(),
                    teamID: viewModel.teamIDRef,
                    workspacesRepository: workspacesRepository,
                    agentPresenceStore: agentPresenceStore
                ) { actorID, workspaceID, workspacePath, agentType in
                    Task {
                        await viewModel.addAgent(
                            actorID: actorID,
                            workspaceID: workspaceID,
                            worktreePath: workspacePath,
                            agentType: agentType.asAmuxAgentType
                        )
                    }
                }
            }
            .sheet(isPresented: $isAddMemberSheetPresented) {
                AddMemberSheet(
                    excludedActorIDs: viewModel.existingParticipantActorIDs,
                    accessibleAgentIDs: Set(connectedAgentsStore?.agents.map(\.id) ?? []),
                    currentActorID: viewModel.currentHumanActorIDRef,
                    actorStore: actorStore,
                    agentPresenceStore: agentPresenceStore
                ) { humanActorIDs in
                    Task { await viewModel.addMembers(humanActorIDs) }
                }
            }
        }
        .sheet(item: $editingEvent) { event in
            EditMessageSheet(initialText: event.text ?? "") { newContent in
                guard let messageID = event.supabaseMessageId else { return }
                Task {
                    await viewModel.editUserMessage(
                        supabaseMessageID: messageID,
                        newContent: newContent
                    )
                }
            }
        }
        .confirmationDialog(
            "Delete this message?",
            isPresented: Binding(
                get: { pendingDeleteEvent != nil },
                set: { if !$0 { pendingDeleteEvent = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDeleteEvent
        ) { event in
            Button("Delete", role: .destructive) {
                guard let messageID = event.supabaseMessageId else { return }
                Task {
                    await viewModel.deleteUserMessage(supabaseMessageID: messageID)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The message is removed for everyone in this session.")
        }
        .task {
            // Build & start the outbox sender once the modelContext (and
            // its container) is available. Idempotent — `OutboxSender.start`
            // bails if a loop task is already running, so re-entry from
            // re-task does not spawn duplicates.
            if viewModel.outboxSender == nil, let svc = pendingTeamcluService {
                let sender = OutboxSender(
                    teamclu: svc,
                    modelContainer: modelContext.container
                )
                viewModel.outboxSender = sender
            }
            await viewModel.outboxSender?.start()
            viewModel.start(modelContext: modelContext)
            await viewModel.refreshMemberSheet()
            await viewModel.loadFeedback()
        }
        .onChange(of: viewModel.attachmentStateKey) { _, _ in
            // An attachment for this session changed lifecycle (attached →
            // running → idle → detached). Re-shape the member sheet so the
            // row dot colour and the model list track it.
            Task { await viewModel.refreshMemberSheet() }
        }
        .onChange(of: viewModel.isStreaming) { _, newValue in
            // First ACP event arrived — the agent is definitely up even if
            // the attachment's status field hasn't propagated through
            // @Observable yet (a known limitation: SwiftData mutations don't
            // re-evaluate computed nested optionals). Refresh so the chip
            // flips spawning → active
            // and the member sheet row's "loading" turns into the
            // current model picker.
            if newValue {
                Task { await viewModel.refreshMemberSheet() }
            }
        }
        .onChange(of: viewModel.isActive) { _, newValue in
            // isActive covers thinking + tool_use windows ahead of any
            // raw text output. Refresh on the rising edge too so the
            // chip's stop icon appears as soon as the agent starts
            // working, not only when text begins streaming.
            if newValue {
                Task { await viewModel.refreshMemberSheet() }
            }
        }
        .onChange(of: viewModel.isAgentWorking) { _, newValue in
            if newValue {
                Task { await viewModel.refreshMemberSheet() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // The streaming buffer lives in `streamingTextByAgent`,
            // which is in-memory only. If iOS reclaims the suspended
            // process, that partial text vanishes — and on cold relaunch
            // the resume path has nothing to hydrate from. Snapshot it
            // to SwiftData on background so the cold-launch hydrate
            // picks it up; on the common case where the process
            // survives, the foreground hook deletes the snapshot so it
            // doesn't double-render alongside the still-live buffer.
            // MQTT reconnect is owned by `ContentView`'s own scenePhase
            // observer.
            switch phase {
            case .background:
                viewModel.flushStreamingForBackground()
            case .active:
                viewModel.discardBackgroundSnapshot()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
        .onDisappear {
            // Do NOT call viewModel.stop() here. SwiftUI fires this hook
            // both when this view is being popped out of the nav stack
            // (true exit) AND when a destination is pushed on top of it
            // (we're still in the back-stack). The two are indistinguishable
            // at this hook, but the cost of treating "push" as "exit" is
            // brutal: cancelling the MQTT task drops every ACP envelope
            // that arrives while StreamingDetailView (or any destination)
            // is on top, so the live-stream view freezes on whatever
            // events it had at push time and the bubbles only appear after
            // popping back triggers incremental sync replay.
            //
            // Lifetime is now owned by the VM itself: its `deinit`
            // cancels the task, which fires when the owning view (the
            // ancestor that holds the VM via @State / @Bindable) drops
            // its last reference. The task captures `self` weakly so
            // the retain cycle that would otherwise prevent deinit is
            // broken.
        }
    }

    private var resolvedModelId: String? {
        // Per-agent model selection is owned by AgentsSheet via
        // viewModel.setModel(forAgent:model:), so there's no session-level
        // override on the view. Report the model of the agent this send will
        // actually reach; nil when no agent is attached (the session is cold
        // and the daemon will pick on spawn).
        guard let current = viewModel.currentModelForSendTarget, !current.isEmpty else { return nil }
        return current
    }

    private var initialFeedScrollKey: String {
        "\(viewModel.hasLoadedInitialFeed)-\(viewModel.feedItems.count)-\(viewModel.feedItems.last?.id ?? "none")"
    }

    private func considerAutoOpeningPlans(count: Int) {
        if count > 0 && !hasAutoOpenedPlans {
            hasAutoOpenedPlans = true
            if let saved = savedPlansPanelState() {
                withAnimation(AMUXAnimation.fast) {
                    isPlansPanelPresented = saved
                }
            } else {
                withAnimation(AMUXAnimation.fast) {
                    isPlansPanelPresented = true
                }
            }
        }
        if count == 0 && isPlansPanelPresented {
            withAnimation(AMUXAnimation.fast) {
                isPlansPanelPresented = false
            }
        }
    }

    private func plansPanelDefaultsKey() -> String? {
        guard let sid = viewModel.session?.sessionId, !sid.isEmpty else { return nil }
        return "session.plansPanelOpen.\(sid)"
    }

    private func savedPlansPanelState() -> Bool? {
        guard let key = plansPanelDefaultsKey(),
              UserDefaults.standard.object(forKey: key) != nil else { return nil }
        return UserDefaults.standard.bool(forKey: key)
    }

    private func persistPlansPanelState(_ open: Bool) {
        guard let key = plansPanelDefaultsKey() else { return }
        UserDefaults.standard.set(open, forKey: key)
    }

    /// Resolve an agent actor id to a member-sheet display name. Falls
    /// back to a truncated id so an unmapped sender still has a label.
    private func agentDisplayName(for agentID: String) -> String {
        viewModel.memberSheetAgents.first(where: { $0.id == agentID })?.displayName
            ?? String(agentID.prefix(8))
    }

    /// Pick the best single-line summary for the active-stream card.
    /// Priority: live streaming text → most recent thinking/output text
    /// → most recent tool name → "Working…". The card truncates further
    /// at the view layer.
    /// Tracks what the keyboard covers, and follows the bottom of the
    /// transcript whenever it grows.
    ///
    /// The keyboard takes roughly half the screen and the composer rides up
    /// with it, over whatever was at the bottom of the feed. Push the feed up
    /// to match — but only for someone who was already reading the newest
    /// message. Someone parked in the middle of the history is browsing, and
    /// yanking them to the bottom because they tapped the field would lose
    /// their place.
    @MainActor
    private func scrollToBottom() {
        Task { @MainActor in
            // One turn of the loop so the resize that triggered this has
            // finished laying out; scrolling into the old geometry lands short.
            await Task.yield()
            withAnimation(AMUXAnimation.fast) {
                scrollProxy?.scrollTo("session-detail-bottom", anchor: .bottom)
            }
        }
    }

    /// One line for the active-stream card: the turn's own message text and
    /// nothing else — the live delta buffer, else the newest `output` entry.
    ///
    /// Thinking and tool calls deliberately don't feed this line. They used
    /// to, which made the card narrate the agent's internals ("Running
    /// bash…", a reasoning fragment) instead of what it is saying. Both live
    /// on the trace page behind the card's chevron.
    ///
    /// Returns "" when there is no message text yet, handing the fallback
    /// copy to `ActiveStreamCardView` — it owns that string and localizes it,
    /// whereas the literals here never were.
    private func activeStreamLastLine(agentID: String, runtimeEvents: [AgentEvent]) -> String {
        let live = viewModel.streamingTextByAgent[agentID] ?? ""
        if !live.isEmpty {
            // The card is lineLimit(1). Operate on the buffer tail so a
            // 50KB reply doesn't get copied and newline-replaced in full
            // on every token — the visible output is identical.
            return live.suffix(240).replacingOccurrences(of: "\n", with: " ")
        }
        if let last = runtimeEvents.reversed().first(where: { e in
            e.eventType == "output" && !(e.text ?? "").isEmpty
        }) {
            return (last.text ?? "").suffix(240).replacingOccurrences(of: "\n", with: " ")
        }
        return ""
    }

    @ViewBuilder
    private func feedItemRow(_ item: FeedItem) -> some View {
        switch item {
        case .userMessage(let event), .permission(let event), .todo(let event), .error(let event):
            EventBubbleView(
                event: event,
                runtime: viewModel.attachment(forAgentActorID: event.senderActorID ?? ""),
                onGrant: { id, agentID in Task { try? await viewModel.grantPermission(requestId: id, agentActorID: agentID) } },
                onDeny: { id, agentID in Task { try? await viewModel.denyPermission(requestId: id, agentActorID: agentID) } },
                onGrantOption: { id, optionID, agentID in
                    Task { try? await viewModel.grantPermission(requestId: id, agentActorID: agentID, optionID: optionID) }
                },
                permissionOptions: { viewModel.permissionOptions(for: $0) },
                onRetryOutbox: { msgID in
                    if let sender = viewModel.outboxSender {
                        Task { await sender.retry(messageID: msgID) }
                    }
                },
                actorMap: cachedActorMap,
                onEdit: canModifyMessage(event) ? { editingEvent = event } : nil,
                onDelete: canModifyMessage(event) ? { pendingDeleteEvent = event } : nil,
                replyQuote: viewModel.replyQuote(forSupabaseMessageID: event.supabaseMessageId),
                onTapQuote: {
                    guard let quote = viewModel.replyQuote(forSupabaseMessageID: event.supabaseMessageId),
                          let targetID = viewModel.feedItemID(forSupabaseMessageID: quote.messageID)
                    else { return }
                    withAnimation { scrollProxy?.scrollTo(targetID, anchor: .center) }
                }
            )
        case .activeStream(_, let agentID, let runtimeEvents):
            // NavigationLink(destination:) instead of value-based push
            // because the parent NavigationStack uses a `[String]`-typed
            // path (SessionsTab / IdeasTab) — value-based pushes of
            // `TurnRoute` would be silently dropped by SwiftUI when the
            // type doesn't match the path's element type.
            //
            // `isPending` is true between send-tap and the first ACP
            // delta/event arrival. In that window the card is surfaced
            // by `markAgentWorking()` priming `streamingAgentSet` —
            // there are no runtime events and no live text buffer yet,
            // so we render the cinnabar breathing light + "Agent
            // loading…". The first delta both populates `runtimeEvents`
            // /`streamingTextByAgent` and flips `isPending` false, at
            // which point the dot transitions to sage and the label
            // switches to the live last-line preview.
            let liveText = viewModel.streamingTextByAgent[agentID] ?? ""
            let isPending = runtimeEvents.isEmpty && liveText.isEmpty
            NavigationLink(
                destination: StreamingDetailView(
                    route: TurnRoute(agentID: agentID, frozenTurnID: nil),
                    viewModel: viewModel
                )
            ) {
                ActiveStreamCardView(
                    agentName: agentDisplayName(for: agentID),
                    lastLine: activeStreamLastLine(agentID: agentID, runtimeEvents: runtimeEvents),
                    isPending: isPending
                )
            }
            .buttonStyle(.plain)
        case .completedTurn(let id, let agentID, let final, _):
            CompletedTurnBubbleView(
                finalEvent: final,
                runtime: viewModel.attachment(forAgentActorID: agentID),
                agentName: agentDisplayName(for: agentID),
                feedbackKind: final.supabaseMessageId.flatMap { viewModel.feedbackByMessageID[$0] },
                onFeedback: final.supabaseMessageId.map { messageID in
                    { kind in Task { await viewModel.setFeedback(messageID: messageID, kind: kind) } }
                },
                detailIcon: {
                    // Always offer the detail entry point — even text-only
                    // turns benefit from giving the user access to the
                    // turn's daemon-recorded trace (model, timing, future
                    // tool calls if requestTurnHistory finds them).
                    //
                    // Pebble-filled capsule with cinnabar label so the
                    // affordance reads as a button rather than decoration.
                    // Previous 13pt secondary glyph was easy to miss; the
                    // bubble shows only the final reply text now, so the
                    // turn's thinking + tool calls only surface here.
                    NavigationLink(
                        destination: StreamingDetailView(
                            route: TurnRoute(agentID: agentID, frozenTurnID: id),
                            viewModel: viewModel
                        )
                    ) {
                        HStack(spacing: 3) {
                            Image(systemName: "list.bullet.indent")
                                .font(.system(size: 10, weight: .semibold))
                            Text("Process")
                                .font(.system(size: 11, weight: .medium))
                        }
                        .foregroundStyle(Color.amux.cinnabar)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(Color.amux.pebble.opacity(0.85))
                                .overlay(
                                    Capsule().stroke(Color.amux.hairline, lineWidth: 0.5)
                                )
                        )
                        .padding(6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("View process")
                }
            )
        }
    }

    /// Edit/delete are offered only for the signed-in user's own prompts
    /// that have already landed in the backend — `supabaseMessageId` is the
    /// PATCH/DELETE routing key, so a still-in-outbox bubble (nil id) has
    /// nothing to mutate remotely yet. Agent replies and system rows never
    /// qualify (eventType gate).
    private func canModifyMessage(_ event: AgentEvent) -> Bool {
        guard event.eventType == "user_prompt",
              event.supabaseMessageId != nil,
              let sender = event.senderActorID, !sender.isEmpty,
              let me = viewModel.currentHumanActorIDRef, !me.isEmpty
        else { return false }
        return sender == me
    }

    private func mentionTargets() -> [MentionTarget] {
        let members = viewModel.memberSheetHumans.map { h in
            MentionTarget(id: h.id, displayName: h.displayName, subtitle: "Member", kind: .member)
        }
        let agents = viewModel.memberSheetAgents.map { a in
            // Subtitle shows the agent type only. The chip bar above the
            // composer carries the live lifecycle state, which arrives on the
            // actor retain; repeating it here would show a value captured at
            // sheet-open time and go stale within seconds.
            MentionTarget(id: a.id, displayName: a.displayName, subtitle: a.agentType, kind: .agent)
        }
        return agents + members
    }
}

// MARK: - OpenCode question dock

private struct AcpQuestionCard: View {
    let pending: PendingAcpQuestion
    let onSubmit: ([[String]]) async throws -> Void
    let onSkip: () async throws -> Void

    @State private var page = 0
    @State private var selected: [String: Set<String>] = [:]
    @State private var customAnswers: [String: String] = [:]
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var prompt: AcpQuestionPrompt { pending.questions[page] }

    private var currentAnswers: [String] {
        let custom = customAnswers[prompt.id, default: ""]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !custom.isEmpty { return [custom] }
        return Array(selected[prompt.id, default: []]).sorted()
    }

    private var canContinue: Bool {
        !isSubmitting && !currentAnswers.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(prompt.header.isEmpty ? "Question" : prompt.header)
                    .font(.headline)
                    .foregroundStyle(Color.amux.onyx)
                Spacer()
                if pending.questions.count > 1 {
                    Button { page = max(0, page - 1) } label: {
                        Image(systemName: "chevron.left")
                    }
                    .disabled(page == 0 || isSubmitting)
                    Text("\(page + 1) of \(pending.questions.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Color.amux.slate)
                    Button { page = min(pending.questions.count - 1, page + 1) } label: {
                        Image(systemName: "chevron.right")
                    }
                    .disabled(page == pending.questions.count - 1 || isSubmitting)
                }
            }

            Text(prompt.question)
                .font(.subheadline)
                .foregroundStyle(Color.amux.basalt)

            VStack(spacing: 4) {
                ForEach(Array(prompt.options.enumerated()), id: \.element.id) { index, option in
                    let isSelected = selected[prompt.id, default: []].contains(option.label)
                    Button {
                        toggle(option.label)
                    } label: {
                        HStack(spacing: 10) {
                            Text("\(index + 1).")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.amux.slate)
                                .frame(width: 22, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label)
                                    .font(.subheadline.weight(.semibold))
                                if !option.description.isEmpty {
                                    Text(option.description)
                                        .font(.caption)
                                        .foregroundStyle(Color.amux.slate)
                                }
                            }
                            Spacer()
                            if isSelected {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.amux.cinnabar)
                            }
                        }
                        .foregroundStyle(Color.amux.onyx)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(isSelected ? Color.amux.pebble : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(isSubmitting)
                }
            }

            HStack(spacing: 10) {
                TextField(
                    prompt.options.isEmpty ? "Type your answer…" : "Or type a custom answer…",
                    text: Binding(
                        get: { customAnswers[prompt.id, default: ""] },
                        set: { customAnswers[prompt.id] = $0 }
                    )
                )
                .textFieldStyle(.plain)
                .font(.subheadline)
                .disabled(isSubmitting)

                Button("Skip") {
                    submitSkip()
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(Color.amux.slate)
                .disabled(isSubmitting)

                Button(page == pending.questions.count - 1 ? "Submit" : "Continue") {
                    continueOrSubmit()
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.amux.paper)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Color.amux.onyx.opacity(canContinue ? 1 : 0.35), in: Capsule())
                .disabled(!canContinue)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(Color.amux.cinnabarDeep)
            }
        }
        .padding(14)
        .background(Color.amux.paper, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.amux.hairline, lineWidth: 0.5)
        )
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.amux.mist)
        .accessibilityIdentifier("session.questionCard")
    }

    private func toggle(_ label: String) {
        customAnswers[prompt.id] = ""
        if prompt.allowsMultiple {
            if selected[prompt.id, default: []].contains(label) {
                selected[prompt.id]?.remove(label)
            } else {
                selected[prompt.id, default: []].insert(label)
            }
        } else {
            selected[prompt.id] = [label]
        }
    }

    private func continueOrSubmit() {
        guard canContinue else { return }
        if page < pending.questions.count - 1 {
            page += 1
            return
        }
        let answers = pending.questions.map { question -> [String] in
            let custom = customAnswers[question.id, default: ""]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return custom.isEmpty ? Array(selected[question.id, default: []]).sorted() : [custom]
        }
        guard answers.allSatisfy({ !$0.isEmpty }) else {
            errorMessage = String(localized: "Answer each question before submitting.")
            return
        }
        isSubmitting = true
        Task {
            do {
                try await onSubmit(answers)
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }

    private func submitSkip() {
        isSubmitting = true
        Task {
            do {
                try await onSkip()
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }
}

// MARK: - EditMessageSheet
//
// Minimal Hai editor for rewriting an own prompt: mist canvas, a single
// paper card holding the TextEditor, Cancel/Save in the nav bar. Save is
// disabled while the draft trims to empty so the PATCH can never blank a
// message out.

private struct EditMessageSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String
    private let onSave: (String) -> Void

    init(initialText: String, onSave: @escaping (String) -> Void) {
        _draft = State(initialValue: initialText)
        self.onSave = onSave
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextEditor(text: $draft)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.onyx)
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .frame(maxWidth: .infinity, minHeight: 160, maxHeight: .infinity, alignment: .topLeading)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.amux.paper)
                    )
                    .padding(16)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color.amux.mist)
            .navigationTitle("Edit Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(trimmedDraft)
                        dismiss()
                    }
                    .disabled(trimmedDraft.isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - AgentChipBar.LifecycleChipState translation

extension AgentChipBar.LifecycleChipState {
    static func fromCore(_ s: AgentLifecycleState) -> AgentChipBar.LifecycleChipState {
        switch s {
        case .spawning: .spawning
        case .ready: .ready
        case .idle: .idle
        case .active: .active
        case .stopped: .stopped
        case .error: .error
        }
    }
}

/// What `SessionDetailView` watches the transcript's scroll for: how far the
/// bottom is, and the two numbers whose change means the viewport resized
/// under the content rather than the user having scrolled it.
private struct ScrollBottomMetrics: Equatable {
    let distanceFromBottom: CGFloat
    let viewportHeight: CGFloat
    let bottomInset: CGFloat
}
