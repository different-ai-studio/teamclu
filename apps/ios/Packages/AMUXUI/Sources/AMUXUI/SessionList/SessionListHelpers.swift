import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

#if os(iOS)

// MARK: - SessionListContent

struct SessionListContent: View {
    @Bindable var viewModel: SessionListViewModel
    let refreshSessionsFromBackend: () async -> Void
    @Binding var navigationPath: [String]
    @Binding var isEditing: Bool
    @Binding var selectedIDs: Set<String>
    let teamcluService: TeamcluService?
    let pairing: PairingManager
    let mqtt: MQTTService
    let actorId: String
    /// Signed-in user's actor id (Supabase `actors.id`). Drives the "you = Cinnabar"
    /// chip in the participant cluster. Distinct from `actorId` above, which
    /// is the daemon peer id derived from the pairing token.
    let currentActorID: String?
    /// True when the current user has zero accessible agents in this team.
    /// The empty-state copy switches to an invite-first-agent CTA in that case.
    let noAccessibleAgent: Bool
    /// Tap handler for the empty-state CTA. Caller presents an invite sheet.
    /// Pass nil to hide the action (e.g. when no ActorStore is available yet).
    let onInviteFirstAgent: (() -> Void)?
    /// Per-session mute state + toggle. Nil hides the mute affordances
    /// (e.g. before the team runtime is built).
    let notificationPrefsStore: NotificationPrefsStore?
    /// Backs the "Mark as unread" swipe action. Nil hides the action —
    /// without the server rewind the next unread reconcile would clear the
    /// local flag again, so a purely-local flip would just flicker.
    let sessionsListRepository: (any SessionsRepository)?
    /// Drives each row's leading dot. Nil (previews, tests) draws every row
    /// quiet rather than guessing from the actor retain, which cannot see a
    /// turn boundary at all.
    let liveActivityStore: SessionLiveActivityStore?

    @Environment(\.modelContext) private var modelContext

    /// Session being renamed via the context-menu alert; nil = alert hidden.
    @State private var renameTarget: Session?
    @State private var renameText = ""

    /// Locally-cached team directory keyed by actor id. Drives initials,
    /// display name, and agent-vs-human shaping for the participant cluster.
    @Query private var allActors: [CachedActor]

    /// Most-recent cached messages across all sessions. Capped — we only
    /// need to discover distinct senders per session for the participant
    /// cluster, not replay threads, and the messages table grows without
    /// bound as history accumulates.
    @Query(SessionListContent.recentMessagesDescriptor)
    private var recentMessages: [SessionMessage]

    private static var recentMessagesDescriptor: FetchDescriptor<SessionMessage> {
        var descriptor = FetchDescriptor<SessionMessage>(
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        descriptor.fetchLimit = 500
        return descriptor
    }

    private var flatSessions: [Session] {
        viewModel.groupedSessions.flatMap(\.items)
    }

    private var actorByID: [String: CachedActor] {
        Dictionary(allActors.map { ($0.actorId, $0) }, uniquingKeysWith: { a, _ in a })
    }

    /// Distinct senderActorIds per session, ordered by most-recent message
    /// first. Built once per body evaluation so each row gets a synchronous
    /// lookup instead of a per-row SwiftData fetch.
    private var sendersBySession: [String: [String]] {
        var ordered: [String: [String]] = [:]
        var seen: [String: Set<String>] = [:]
        for msg in recentMessages {
            let sid = msg.sessionId
            let aid = msg.senderActorId
            if sid.isEmpty || aid.isEmpty { continue }
            if seen[sid, default: []].contains(aid) { continue }
            seen[sid, default: []].insert(aid)
            ordered[sid, default: []].append(aid)
        }
        return ordered
    }

    private func participantPreviews(for session: Session) -> [ParticipantPreview] {
        let directory = actorByID
        let senders = sendersBySession[session.sessionId] ?? []

        var ids: [String] = []
        var seen = Set<String>()
        func add(_ id: String?) {
            guard let id, !id.isEmpty, !seen.contains(id) else { return }
            ids.append(id); seen.insert(id)
        }

        // Order: current user first (so the "YT" chip leads the stack),
        // then the primary agent, then anyone else who has spoken. Falls
        // through to session.createdBy when the user hasn't sent a message
        // yet — covers freshly-created sessions before any reply arrives.
        if let me = currentActorID { add(me) }
        add(session.primaryAgentId)
        if !session.createdBy.isEmpty { add(session.createdBy) }
        for sender in senders { add(sender) }

        return ids.prefix(ParticipantCluster.maxVisible).map { id in
            let actor = directory[id]
            return ParticipantPreview(
                actorID: id,
                displayName: actor?.displayName ?? "",
                isAgent: actor?.isAgent ?? false,
                isCurrentUser: id == currentActorID,
                defaultAgentType: actor?.defaultAgentType
            )
        }
    }
    private var hasContent: Bool { !flatSessions.isEmpty }
    private var hasActiveSearch: Bool {
        !viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        // Single List for everything so the daemon banner + search field
        // scroll out of view alongside the session rows, freeing vertical
        // real estate on long lists. The header lives as a normal, non-
        // sticky row at the top; loading / empty states sit in their own
        // borderless row beneath it.
        List {
            headerRow

            if !hasContent && viewModel.isLoading {
                loadingRow
            } else if !hasContent {
                emptyRow
            } else {
                // Plain flat list — day grouping retired per
                // sessions-list.jsx, which uses only hairline separators
                // inset under the title (handled by AgentRowView's
                // alignmentGuide(.listRowSeparatorLeading)).
                ForEach(flatSessions, id: \.sessionId) { session in
                    sessionRow(session)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.amux.mist)
        .refreshable {
            await refreshSessionsFromBackend()
        }
        .alert(
            "Rename Session",
            isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            ),
            presenting: renameTarget
        ) { session in
            TextField("Title", text: $renameText)
            Button("Rename") {
                let sid = session.sessionId
                let title = renameText
                renameTarget = nil
                Task {
                    await viewModel.renameSession(
                        sessionId: sid,
                        newTitle: title,
                        sessionsRepo: sessionsListRepository,
                        modelContext: modelContext
                    )
                }
            }
            Button("Cancel", role: .cancel) { renameTarget = nil }
        }
    }

    @ViewBuilder
    private var headerRow: some View {
        VStack(spacing: 8) {
            DaemonStatusBanner(pairing: pairing, mqtt: mqtt)
            HStack(spacing: 8) {
                SessionListSearchField(text: $viewModel.searchText)
                // Clock view: show ONLY scheduled (cron) sessions — they are
                // hidden from the default list, mirroring the desktop.
                Button {
                    withAnimation(AMUXAnimation.fast) {
                        viewModel.showCronSessions.toggle()
                    }
                } label: {
                    Image(systemName: viewModel.showCronSessions ? "clock.fill" : "clock")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(viewModel.showCronSessions ? Color.amux.cinnabar : Color.amux.basalt)
                        .frame(width: 36, height: 36)
                        .background(
                            Circle().fill(
                                viewModel.showCronSessions
                                    ? Color.amux.cinnabar.opacity(0.12)
                                    : Color.amux.pebble
                            )
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(viewModel.showCronSessions ? "Show regular sessions" : "Show scheduled sessions")
                .accessibilityIdentifier("sessions.cronToggle")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
    }

    @ViewBuilder
    private var loadingRow: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading sessions…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private var emptyRow: some View {
        Group {
            if hasActiveSearch {
                ContentUnavailableView.search(text: viewModel.searchText)
            } else if viewModel.showCronSessions {
                ContentUnavailableView(
                    "No Scheduled Sessions",
                    systemImage: "clock",
                    description: Text("Sessions created by scheduled tasks appear here.")
                )
            } else if noAccessibleAgent {
                ContentUnavailableView {
                    Label("Invite your first agent", systemImage: "cpu")
                } description: {
                    Text("You don't have access to any agent in this team yet. Invite one to start a session.")
                } actions: {
                    Button {
                        onInviteFirstAgent?()
                    } label: {
                        Text("Invite agent")
                            .fontWeight(.semibold)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                    }
                    .glassProminentButtonStyle()
                    .accessibilityIdentifier("sessions.inviteFirstAgentButton")
                }
            } else {
                ContentUnavailableView("No Sessions", systemImage: "cpu",
                    description: Text("Start a new session to begin"))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 280)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private func sessionRow(_ session: Session) -> some View {
        let runtime = liveAttachment(for: session)
        HStack(spacing: 10) {
            if isEditing {
                Image(systemName: selectedIDs.contains(session.sessionId) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedIDs.contains(session.sessionId) ? .blue : .secondary)
                    .font(.title3)
                    .onTapGesture { toggleSelection(session.sessionId) }
            }
            AgentRowView(
                session: session,
                runtime: runtime,
                workspaceName: workspaceName(runtime: runtime),
                participants: participantPreviews(for: session),
                isMuted: notificationPrefsStore?.isMuted(session.sessionId) ?? false,
                activity: liveActivityStore?.activity(for: session.sessionId) ?? .quiet
            )
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if isEditing {
                toggleSelection(session.sessionId)
            } else {
                viewModel.markAsRead(sessionId: session.sessionId)
                navigationPath.append("session:\(session.sessionId)")
            }
        }
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        // Plain-list rows default to systemBackground (stark white) which
        // breaks the seamless-on-Mist treatment from sessions-list.jsx. Clear
        // the per-row fill and pin the hairline separator to the Hai token so
        // the only visible structure is the subtle inset rule under the title.
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Color.amux.hairline)
        .contextMenu {
            Button {
                renameText = session.title
                renameTarget = session
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            if let store = notificationPrefsStore {
                let isMuted = store.isMuted(session.sessionId)
                Button {
                    Task { await store.toggleMute(sessionID: session.sessionId) }
                } label: {
                    Label(isMuted ? "Unmute notifications" : "Mute notifications",
                          systemImage: isMuted ? "bell" : "bell.slash")
                }
            }

            Divider()

            Button(role: .destructive) {
                archive(session)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                archive(session)
            } label: {
                Label("Archive", systemImage: "archivebox.fill")
            }
            .tint(Color.amux.cinnabarDeep)

            Button {
                session.isPinned.toggle()
                try? modelContext.save()
            } label: {
                Label(session.isPinned ? "Unpin" : "Pin",
                      systemImage: session.isPinned ? "pin.slash.fill" : "pin.fill")
            }
            .tint(Color.amux.basalt)
        }
        // Leading swipe = read-state, mirroring Mail/iMessage muscle memory.
        // Only offered while the session reads as "read" — flipping an
        // already-unread row would be a no-op that just hides the dot's
        // provenance. Opening the session still clears it via the existing
        // mark-viewed path in SessionDetailViewModel.start().
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if sessionsListRepository != nil && !session.hasUnread {
                Button {
                    Task {
                        await viewModel.markSessionUnread(
                            sessionId: session.sessionId,
                            sessionsRepo: sessionsListRepository,
                            modelContext: modelContext
                        )
                    }
                } label: {
                    Label("Mark as unread", systemImage: "envelope.badge")
                }
                .tint(Color.amux.cinnabar)
            }
        }
    }

    /// The attachment serving this session, or nil when it is cold.
    ///
    /// Rows are keyed (actor, session); a session whose agents live on two
    /// machines has one row per machine. The list row shows one, so take the
    /// most recently active. A row that has never reported an event sorts
    /// last rather than crashing the comparison.
    private func liveAttachment(for session: Session) -> AgentAttachment? {
        viewModel.attachments
            .filter { $0.sessionID == session.sessionId }
            .max(by: { ($0.lastEventTime ?? .distantPast) < ($1.lastEventTime ?? .distantPast) })
    }

    /// Prefers the live runtime's workspace: it comes from the attachment the
    /// daemon currently holds, where the cached row may describe a spawn that
    /// has since been replaced.
    private func workspaceName(runtime: AgentAttachment?) -> String {
        guard let id = runtime?.workspaceID, !id.isEmpty else { return "" }
        return viewModel.workspaces.first(where: { $0.workspaceId == id })?.displayName ?? ""
    }

    private func toggleSelection(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) }
        else { selectedIDs.insert(id) }
    }

    /// Server-backed archive: flips `archived_at` via the Cloud API so the
    /// session leaves every device's list, with the local flag as the
    /// immediate mirror. Falls back to local-only when no repository is
    /// wired (previews).
    private func archive(_ session: Session) {
        guard let repo = sessionsListRepository else {
            session.isArchived = true
            try? modelContext.save()
            return
        }
        let sid = session.sessionId
        Task {
            await viewModel.archiveSession(
                sessionId: sid,
                sessionsRepo: repo,
                modelContext: modelContext
            )
        }
    }
}

// MARK: - AgentRowView

struct AgentRowView: View {
    let session: Session
    let runtime: AgentAttachment?
    let workspaceName: String
    let participants: [ParticipantPreview]
    let isMuted: Bool
    /// What the leading dot says, reduced from `session/{id}/live` by
    /// `SessionLiveActivityStore`. Not taken from `runtime`: the actor retain
    /// is only republished on attach/detach, so its status cannot see a turn
    /// start or a pending permission.
    let activity: SessionLiveActivity

    init(
        session: Session,
        runtime: AgentAttachment? = nil,
        workspaceName: String = "",
        participants: [ParticipantPreview] = [],
        isMuted: Bool = false,
        activity: SessionLiveActivity = .quiet
    ) {
        self.session = session
        self.runtime = runtime
        self.workspaceName = workspaceName
        self.participants = participants
        self.isMuted = isMuted
        self.activity = activity
    }

    private var displayTitle: String {
        session.title.isEmpty ? "Untitled Session" : session.title
    }

    private var lastMessage: String { session.lastMessagePreview }
    // Server-computed: `list_current_actor_sessions` derives it from
    // session_read_markers + sessions.last_message_at. The old client-side
    // signal rode on `lastOutputSummary`/`toolUseCount` deltas, which the
    // actor retain does not carry (ADR-0004), so this is the only source now.
    private var isUnread: Bool { session.hasUnread }

    /// The only thing still read off the actor retain: a torn-down attachment
    /// dims the title. Active/Idle are deliberately NOT read here — the retain
    /// is republished on attach/detach only, so it cannot see a turn.
    private var isStopped: Bool { runtime?.status == 5 }

    /// The word beside the workspace name. Driven by the dot's signal, not by
    /// `runtime.statusLabel`: the actor retain is only republished on
    /// attach/detach, so its Active/Idle would contradict the dot for most of
    /// a turn. Quiet sessions say nothing rather than "Idle" — the row's
    /// timestamp already covers "nothing is happening".
    private var statusLabel: String {
        switch activity {
        case .needsAttention: String(localized: "Waiting for you")
        case .running:        String(localized: "Working")
        case .quiet:          ""
        }
    }

    private var statusForeground: Color {
        activity == .needsAttention ? Color.amux.cinnabar : Color.amux.sage
    }

    private var rowTimestamp: Date {
        session.lastMessageAt ?? session.createdAt
    }

    private func formatTime(_ date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 60     { return "now" }
        if seconds < 3600   { return "\(seconds / 60)m" }
        if seconds < 86400  { return "\(seconds / 3600)h" }
        if seconds < 604800 { return "\(seconds / 86400)d" }
        let f = DateFormatter()
        f.dateFormat = "MM/dd"
        return f.string(from: date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                activityDot
                Text(displayTitle)
                    .font(.body)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .foregroundStyle(isStopped ? Color.amux.basalt : Color.amux.onyx)
                Spacer(minLength: 4)
                // Quiet muted marker — bare Slate glyph, no capsule, per the
                // Hai restraint rules (status whispers, never shouts).
                if isMuted {
                    Image(systemName: "bell.slash")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.amux.slate)
                        .accessibilityLabel("Muted")
                }
                if isUnread {
                    Circle()
                        .fill(Color.amux.cinnabar)
                        .frame(width: 7, height: 7)
                }
                Text(formatTime(rowTimestamp))
                    .font(.caption)
                    .foregroundStyle(Color.amux.slate)
            }

            if !lastMessage.isEmpty {
                Text(lastMessage)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.basalt)
                    .lineLimit(1)
                    .padding(.leading, badgeIndent)
            }

            metaStrip
                .padding(.leading, badgeIndent)
        }
        .padding(.vertical, 6)
        .alignmentGuide(.listRowSeparatorLeading) { _ in Self.badgeIndent }
    }

    /// Leading inset for the title's continuation lines and the row
    /// separator: the dot's box plus the HStack's 8pt gap.
    private static let badgeIndent: CGFloat = Self.dotBoxWidth + 8
    private var badgeIndent: CGFloat { Self.badgeIndent }
    /// The dot keeps a fixed box whether or not it is drawn, so titles stay
    /// on one vertical line down the list.
    private static let dotBoxWidth: CGFloat = 10

    private var dotColor: Color {
        switch activity {
        case .needsAttention: Color.amux.cinnabar
        case .running:        Color.amux.sage
        // Not absent: an empty gap reads as a rendering bug. A dot at 10%
        // Onyx is present without competing with the title.
        case .quiet:          Color.amux.onyx.opacity(0.10)
        }
    }

    /// One dot, two things worth interrupting someone for: an agent is
    /// working here, or an agent is waiting on this person. Everything the
    /// old badge said — backend initials, Starting/Stopped/cold — has no
    /// reader on a list screen and is gone.
    private var activityDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 6, height: 6)
            .breathingOpacity(active: activity != .quiet)
            .frame(width: Self.dotBoxWidth)
            .accessibilityLabel(
                activity == .needsAttention
                    ? Text("Waiting for you")
                    : Text("Agent working")
            )
            .accessibilityHidden(activity == .quiet)
    }

    @ViewBuilder
    private var metaStrip: some View {
        HStack(spacing: 8) {
            if !workspaceName.isEmpty {
                Text(workspaceName)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.amux.slate)
                    .lineLimit(1)
            }

            if !workspaceName.isEmpty && !statusLabel.isEmpty {
                Circle()
                    .fill(Color.amux.slate.opacity(0.5))
                    .frame(width: 3, height: 3)
            }

            if !statusLabel.isEmpty {
                Text(statusLabel)
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(statusForeground)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            // Right-side participant cluster — `sessions-list.jsx →
            // ParticipantStack`. Source data is stitched together from
            // local SwiftData caches (current user, primary agent, session
            // creator, then anyone who has sent a message) by
            // SessionListContent.participantPreviews; we never round-trip
            // to Supabase for this read.
            if !participants.isEmpty {
                ParticipantCluster(participants: participants)
            }
        }
    }
}

// MARK: - Transition Modifiers

struct ZoomTransitionModifier: ViewModifier {
    let sourceID: String
    let namespace: Namespace.ID
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.navigationTransition(.zoom(sourceID: sourceID, in: namespace))
        } else { content }
    }
}


#endif
