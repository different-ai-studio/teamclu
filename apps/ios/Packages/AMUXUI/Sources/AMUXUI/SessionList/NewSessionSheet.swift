import SwiftUI
import AMUXSharedUI
import SwiftData
import AMUXCore
import os

private let newSessionLogger = Logger(subsystem: "com.teamclu.mobile", category: "NewSession")

// MARK: - NewSessionSheet

public struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    let mqtt: MQTTService
    let peerId: String
    let teamcluService: TeamcluService?
    let teamID: String
    let currentActorID: String?
    let isAgentAvailable: Bool
    let connectedAgentsStore: ConnectedAgentsStore?
    /// Handed to the member picker so it refreshes presence when it opens.
    let actorStore: ActorStore?
    let agentPresenceStore: AgentPresenceStore?
    let workspacesRepository: (any WorkspaceRepository)?
    let sessionsRepository: (any SessionRepository)?
    /// Source of the app picker. Nil (apps disabled for the team, or a caller
    /// without apps) hides the picker.
    let teamAppsStore: TeamAppsStore?

    let viewModel: SessionListViewModel
    let preselectedIdeaId: String?
    let preselectedCollaborators: [CachedActor]
    /// The viewer's effective default agent, when the caller already knows
    /// it. Nil makes the sheet ask the store itself.
    let defaultAgentID: String?
    /// Reloaded on open so the idea picker reads a fresh cache.
    let ideaStore: IdeaStore?

    // Per-agent config (workspace + agent type) keyed by actorId. Resolved
    // automatically from each agent's stored defaults when they're tapped in
    // the picker — no per-session prompt.
    @State private var agentConfigs: [String: AgentConfigSheet.Selection] = [:]
    @State private var workspaceStore: WorkspaceStore?

    @State private var collaborators: [CachedActor] = []
    /// The agent the session is for — starts as the viewer's default, and
    /// is also in `collaborators` / `agentConfigs` like any other agent.
    @State private var primaryAgentID: String?
    /// Set once the user picks (or clears) the agent by hand, so a late
    /// default lookup doesn't overwrite their choice.
    @State private var didChooseAgent = false
    /// Each picked agent's own workspaces, fetched on pick. The team-wide
    /// `workspaces` list is one capped page, so an agent's rows can be
    /// missing from it in a large team.
    @State private var workspacesByAgent: [String: [WorkspaceRecord]] = [:]
    @State private var loadingWorkspacesFor: Set<String> = []
    @State private var selectedIdeaId: String?
    @State private var selectedAppID: String?
    /// The selected agents' own workspaces, fetched per agent once an app is
    /// picked. The team-wide `workspaces` list is one capped page, so the
    /// app's row can be missing from it in a large team.
    @State private var agentWorkspacesForApp: [WorkspaceRecord] = []
    @State private var isCheckingAppCheckout = false
    @State private var messageText: String = ""
    @State private var showMemberPicker = false
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var debugStatusMessage: String?
    @State private var debugTransportMessage: String?
    @FocusState private var isInputFocused: Bool

    @Query(filter: #Predicate<SessionIdea> { !$0.archived },
           sort: \SessionIdea.createdAt, order: .reverse)
    private var cachedIdeas: [SessionIdea]

    /// The cache holds every team this device has been in.
    private var ideas: [SessionIdea] {
        cachedIdeas.filter { $0.teamId.isEmpty || $0.teamId == teamID }
    }

    private var workspaces: [WorkspaceRecord] { workspaceStore?.workspaces ?? [] }

    /// Set by parent — called with agentId when session is created
    var onSessionCreated: ((String) -> Void)?

    public init(mqtt: MQTTService, peerId: String, teamcluService: TeamcluService? = nil,
                teamID: String = "", currentActorID: String? = nil, isAgentAvailable: Bool = true,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                actorStore: ActorStore? = nil,
                agentPresenceStore: AgentPresenceStore? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                sessionsRepository: (any SessionRepository)? = nil,
                teamAppsStore: TeamAppsStore? = nil,
                viewModel: SessionListViewModel,
                preselectedIdeaId: String? = nil,
                preselectedCollaborators: [CachedActor] = [],
                defaultAgentID: String? = nil,
                ideaStore: IdeaStore? = nil,
                onSessionCreated: ((String) -> Void)? = nil) {
        self.mqtt = mqtt
        self.peerId = peerId
        self.teamcluService = teamcluService
        self.teamID = teamID
        self.currentActorID = currentActorID
        self.isAgentAvailable = isAgentAvailable
        self.connectedAgentsStore = connectedAgentsStore
        self.actorStore = actorStore
        self.agentPresenceStore = agentPresenceStore
        self.workspacesRepository = workspacesRepository
        self.sessionsRepository = sessionsRepository
        self.teamAppsStore = teamAppsStore
        self.viewModel = viewModel
        self.preselectedIdeaId = preselectedIdeaId
        self.preselectedCollaborators = preselectedCollaborators
        self.defaultAgentID = defaultAgentID
        self.ideaStore = ideaStore
        self.onSessionCreated = onSessionCreated
    }

    private var canSend: Bool {
        let textOK = !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // At least one other actor (agent or human) must be picked.
        let hasOtherActor = !collaborators.isEmpty
        // Every agent collaborator must have a confirmed AgentConfigSheet selection.
        let agentsConfigured = collaborators
            .filter { $0.isAgent }
            .allSatisfy { agentConfigs[$0.actorId] != nil }
        return textOK && hasOtherActor && agentsConfigured && appBlocker == nil
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Color.amux.mist.ignoresSafeArea()
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            contextCard
                            ForEach(contextNotes, id: \.self) { note in
                                Text(note)
                                    .font(.footnote)
                                    .foregroundStyle(Color.amux.cinnabarDeep)
                                    .padding(.horizontal, 20)
                            }
                            .accessibilityIdentifier("newSession.appBlocker")
                        }
                        .padding(.top, 12)
                        .padding(.bottom, 16)
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                    }
#if DEBUG
                    if let debugStatusMessage, !debugStatusMessage.isEmpty {
                        Text(debugStatusMessage)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                            .lineLimit(2)
                            .accessibilityIdentifier("newSession.debugStatus")
                    }
                    if let debugTransportMessage, !debugTransportMessage.isEmpty {
                        Text(debugTransportMessage)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                            .accessibilityIdentifier("newSession.debugTransport")
                    }
#endif
                    inputBar
                }
                if isSending {
                    Color.black.opacity(0.15).ignoresSafeArea()
                    ProgressView("Starting session…")
                        .padding(24)
                        .liquidGlass(in: RoundedRectangle(cornerRadius: 12), interactive: false)
                }
            }
            .allowsHitTesting(!isSending)
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(.primary)
                    }
                    .accessibilityLabel("Close")
                    .buttonStyle(.plain)
                    .disabled(isSending)
                }
            }
        }
        .sheet(isPresented: $showMemberPicker) {
            MemberListView(
                selected: Set(collaborators.filter { !$0.isAgent }.map(\.actorId)),
                actorStore: actorStore,
                agentPresenceStore: agentPresenceStore,
                currentActorID: currentActorID,
                accessibleAgentIDs: Set(connectedAgentsStore?.agents.map(\.id) ?? []),
                currentPrimaryAgentID: nil,
                excludeActorID: currentActorID,
                externallySelectedIDs: Set(agentConfigs.keys),
                onAgentTap: { actor in
                    if agentConfigs[actor.actorId] != nil {
                        // Tapping an already-configured agent deselects it.
                        agentConfigs.removeValue(forKey: actor.actorId)
                        collaborators.removeAll { $0.actorId == actor.actorId }
                        if actor.actorId == primaryAgentID {
                            primaryAgentID = nil
                            didChooseAgent = true
                        }
                    } else if let selection = resolveAgentDefaults(for: actor) {
                        agentConfigs[actor.actorId] = selection
                        if !collaborators.contains(where: { $0.actorId == actor.actorId }) {
                            collaborators.append(actor)
                        }
                    } else {
                        return String(localized: "This agent has no workspace. Add one in Agent settings.")
                    }
                    return nil
                },
                ordersByRecentContact: true
            ) { selected in
                // `selected` includes humans (from internal selectedIDs) +
                // agents already added via auto-config (passed in via
                // externallySelectedIDs). Replace collaborators wholesale.
                collaborators = selected
            }
            .task { await connectedAgentsStore?.reload() }
        }
        .task {
            if connectedAgentsStore?.agents.isEmpty != false {
                await connectedAgentsStore?.reload()
            }
            await selectDefaultAgent()
        }
        .task { await ideaStore?.reload() }
        .task {
            if let teamAppsStore, !teamAppsStore.hasLoaded { await teamAppsStore.reload() }
        }
        .task(id: appCheckoutQueryKey) { await loadAgentWorkspacesForApp() }
        .onAppear {
            isInputFocused = true
            if selectedIdeaId == nil, let preselectedIdeaId {
                selectedIdeaId = preselectedIdeaId
            }
            if collaborators.isEmpty, !preselectedCollaborators.isEmpty {
                collaborators = preselectedCollaborators
            }
        }
        .task {
            guard workspaceStore == nil, !teamID.isEmpty else { return }
            if let repository = workspacesRepository {
                workspaceStore = WorkspaceStore(teamID: teamID, repository: repository)
                // Load all workspaces (no agent filter) so AgentConfigSheet
                // can show options before the user taps each agent.
                await workspaceStore?.reload(agentID: nil)
            }
        }
    }

    // MARK: - Context card

    /// Who the session is with and what it is about: the agent (the
    /// viewer's default to start with), where it works, an optional idea and
    /// app, and anyone else to bring in.
    private var contextCard: some View {
        HaiPaperCard {
            agentRow
            hairline
            workspaceRow
            hairline
            ideaRow
            if teamAppsStore != nil {
                hairline
                appRow
            }
            hairline
            collaboratorsRow
        }
    }

    private var hairline: some View {
        Rectangle()
            .fill(Color.amux.hairline)
            .frame(height: 0.5)
            .padding(.leading, 14)
    }

    private var agents: [ConnectedAgent] { connectedAgentsStore?.agents ?? [] }

    private var primaryAgent: ConnectedAgent? {
        guard let primaryAgentID else { return nil }
        return agents.first { $0.id == primaryAgentID }
    }

    private var agentRow: some View {
        Menu {
            ForEach(agents) { agent in
                Button {
                    didChooseAgent = true
                    selectPrimaryAgent(agent.id)
                } label: {
                    if agent.id == primaryAgentID {
                        Label(agent.displayName, systemImage: "checkmark")
                    } else {
                        Text(agent.displayName)
                    }
                }
            }
            if primaryAgentID != nil {
                Divider()
                Button {
                    didChooseAgent = true
                    selectPrimaryAgent(nil)
                } label: {
                    Text("No agent")
                }
            }
        } label: {
            HaiSheetRow(
                label: String(localized: "Agent"),
                value: primaryAgent?.displayName ?? String(localized: "Choose agent"),
                valueIsMuted: primaryAgent == nil,
                showsChevron: true
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(agents.isEmpty)
        .accessibilityIdentifier("newSession.agentRow")
    }

    /// The primary agent's own workspaces, falling back to its rows in the
    /// team-wide page until the per-agent fetch lands.
    private var primaryWorkspaces: [WorkspaceRecord] {
        guard let primaryAgentID else { return [] }
        return workspacesByAgent[primaryAgentID]
            ?? workspaces.filter { $0.agentID == primaryAgentID }
    }

    private var workspaceRowValue: (text: String, muted: Bool) {
        guard let primaryAgentID else { return (String(localized: "None"), true) }
        // An app session runs in the agent's checkout of the app, whatever
        // is picked here.
        if let checkout = appCheckout(for: primaryAgentID) {
            return (Self.workspaceName(checkout), false)
        }
        if let id = agentConfigs[primaryAgentID]?.workspaceID,
           let workspace = (primaryWorkspaces + workspaces).first(where: { $0.id == id }) {
            return (Self.workspaceName(workspace), false)
        }
        if loadingWorkspacesFor.contains(primaryAgentID) {
            return (String(localized: "Loading…"), true)
        }
        return (String(localized: "None"), true)
    }

    private var workspaceRow: some View {
        Menu {
            ForEach(primaryWorkspaces) { workspace in
                Button {
                    guard let primaryAgentID else { return }
                    let type = agentConfigs[primaryAgentID]?.agentType
                        ?? resolveAgentDefaults(forAgentID: primaryAgentID)?.agentType
                        ?? .pi
                    agentConfigs[primaryAgentID] = AgentConfigSheet.Selection(
                        workspaceID: workspace.id, agentType: type
                    )
                } label: {
                    if agentConfigs[primaryAgentID ?? ""]?.workspaceID == workspace.id {
                        Label(Self.workspaceName(workspace), systemImage: "checkmark")
                    } else {
                        Text(Self.workspaceName(workspace))
                    }
                }
            }
        } label: {
            HaiSheetRow(
                label: String(localized: "Workspace"),
                value: workspaceRowValue.text,
                valueIsMuted: workspaceRowValue.muted,
                showsChevron: true
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(primaryWorkspaces.isEmpty || selectedApp != nil)
        .accessibilityIdentifier("newSession.workspaceRow")
    }

    private var selectedIdea: SessionIdea? {
        guard let selectedIdeaId else { return nil }
        return ideas.first { $0.ideaId == selectedIdeaId }
    }

    private var ideaRow: some View {
        Menu {
            Button {
                selectedIdeaId = nil
            } label: {
                Label(String(localized: "None"), systemImage: selectedIdeaId == nil ? "checkmark" : "circle")
            }
            if !ideas.isEmpty {
                Divider()
                ForEach(ideas, id: \.ideaId) { idea in
                    Button {
                        selectedIdeaId = idea.ideaId
                    } label: {
                        if idea.ideaId == selectedIdeaId {
                            Label(idea.displayTitle, systemImage: "checkmark")
                        } else {
                            Text(idea.displayTitle)
                        }
                    }
                }
            }
        } label: {
            HaiSheetRow(
                label: String(localized: "Idea"),
                value: selectedIdea?.displayTitle ?? String(localized: "None"),
                valueIsMuted: selectedIdea == nil,
                showsChevron: true
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("newSession.ideaRow")
    }

    /// The session's app. Picking one seats every agent in its checkout of
    /// the app's code.
    private var appRow: some View {
        Menu {
            Button {
                selectedAppID = nil
            } label: {
                Label(String(localized: "None"), systemImage: selectedAppID == nil ? "checkmark" : "circle")
            }
            if let apps = teamAppsStore?.apps, !apps.isEmpty {
                Divider()
                ForEach(apps) { app in
                    Button {
                        selectedAppID = app.id
                    } label: {
                        Label(app.needsDesktopSetup ? String(localized: "\(app.name) (not set up yet)") : app.name,
                              systemImage: selectedAppID == app.id ? "checkmark" : "circle")
                    }
                    // No code yet, so no agent can have a checkout of it.
                    .disabled(app.needsDesktopSetup)
                }
            }
        } label: {
            HaiSheetRow(
                label: String(localized: "App"),
                value: selectedApp?.name ?? String(localized: "None"),
                valueIsMuted: selectedApp == nil,
                showsChevron: true
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("newSession.appRow")
    }

    /// Everyone picked besides the viewer and the primary agent.
    private var otherCollaborators: [CachedActor] {
        collaborators.filter { $0.actorId != primaryAgentID }
    }

    private var collaboratorsRow: some View {
        Button {
            showMemberPicker = true
            isInputFocused = false
        } label: {
            HStack(spacing: 10) {
                Text("Collaborators")
                    .font(.system(size: 14.5))
                    .foregroundStyle(Color.amux.onyx)
                Spacer(minLength: 8)
                if otherCollaborators.isEmpty {
                    Text("None")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.amux.basalt.opacity(0.6))
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(otherCollaborators, id: \.actorId) { member in
                                CollaboratorChip(name: member.displayName) {
                                    removeCollaborator(member)
                                }
                            }
                        }
                        .padding(.vertical, 1)
                    }
                    .defaultScrollAnchor(.trailing)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.amux.slate)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("newSession.collaboratorsRow")
    }

    /// What stands between the user and Send, beyond an empty message.
    private var contextNotes: [String] {
        var notes: [String] = []
        if let primaryAgentID,
           agentConfigs[primaryAgentID] == nil,
           selectedApp == nil,
           !loadingWorkspacesFor.contains(primaryAgentID),
           workspacesByAgent[primaryAgentID] != nil {
            notes.append(String(localized: "This agent has no workspace. Add one in Agent settings."))
        }
        if let appBlocker { notes.append(appBlocker) }
        return notes
    }

    private static func workspaceName(_ workspace: WorkspaceRecord) -> String {
        if !workspace.displayName.isEmpty { return workspace.displayName }
        let last = (workspace.path as NSString).lastPathComponent
        return last.isEmpty ? workspace.path : last
    }

    private var selectedApp: TeamAppRecord? {
        guard let selectedAppID else { return nil }
        return teamAppsStore?.apps.first { $0.id == selectedAppID }
    }

    private var selectedAgentIDs: [String] {
        collaborators.filter(\.isAgent).map(\.actorId).sorted()
    }

    private var appCheckoutQueryKey: String {
        ([selectedAppID ?? ""] + selectedAgentIDs).joined(separator: ",")
    }

    private func loadAgentWorkspacesForApp() async {
        guard selectedAppID != nil, let workspacesRepository, !teamID.isEmpty else {
            agentWorkspacesForApp = []
            return
        }
        isCheckingAppCheckout = true
        defer { isCheckingAppCheckout = false }
        var rows: [WorkspaceRecord] = []
        for agentID in selectedAgentIDs {
            if let found = try? await workspacesRepository.listWorkspaces(teamID: teamID, agentID: agentID) {
                rows.append(contentsOf: found)
            }
        }
        guard !Task.isCancelled else { return }
        agentWorkspacesForApp = rows
    }

    private func appCheckout(for agentID: String) -> WorkspaceRecord? {
        guard let app = selectedApp else { return nil }
        return SessionCreationInput.appCheckoutWorkspace(
            app: app, agentID: agentID, workspaces: agentWorkspacesForApp + workspaces
        )
    }

    /// Selected agents with no checkout of the selected app that iOS can see.
    private var agentsMissingAppCheckout: [CachedActor] {
        collaborators.filter { $0.isAgent && appCheckout(for: $0.actorId) == nil }
    }

    /// Why the selected app blocks sending, if it does. An app session's agent
    /// must work in the app's code, and only a desktop can put that code on
    /// the agent's machine — so rather than quietly seating the agent in its
    /// default folder, the sheet refuses.
    private var appBlocker: String? {
        guard let app = selectedApp else { return nil }
        if !collaborators.contains(where: \.isAgent) {
            return String(localized: "An app session needs an agent. Add an agent as a collaborator first.")
        }
        let missing = agentsMissingAppCheckout
        guard !missing.isEmpty else { return nil }
        if isCheckingAppCheckout { return "正在确认 agent 的电脑上有没有这个应用的代码…" }
        let names = missing.map(\.displayName).joined(separator: "、")
        return "\(names) 所在的电脑上还没有「\(app.name)」的代码，请先在那台电脑的桌面端打开这个应用。"
    }

    // MARK: - Input bar

    private var inputBar: some View {
        LiquidGlassContainer(spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 4) {
                    TextField("Message", text: $messageText, axis: .vertical)
                        .font(.body)
                        .lineLimit(1...5)
                        .focused($isInputFocused)
                        .accessibilityIdentifier("newSession.messageField")
                        .padding(.leading, 14)
                        .padding(.trailing, 4)
                        .padding(.vertical, 10)

                    Button(action: sendAndCreate) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(canSend ? Color.amux.onyx : Color.amux.mist)
                    }
                    .accessibilityIdentifier("newSession.sendButton")
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .padding(.trailing, 6)
                    .padding(.bottom, 6)
                }
                .liquidGlass(in: RoundedRectangle(cornerRadius: 20))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .padding(.bottom, 4)
    }

    // MARK: - Helpers

    /// Builds the text that will be sent as the session's first user message.
    /// If an idea is selected, its title/description prefaces the user's prompt.
    private func firstMessageText(userText: String) -> String {
        guard let id = selectedIdeaId,
              let item = ideas.first(where: { $0.ideaId == id }) else {
            return userText
        }
        let description = item.ideaDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = item.displayTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let ideaBlock: String
        if !description.isEmpty && !title.isEmpty && description != title {
            ideaBlock = "Idea: \(title)\n\n\(description)"
        } else if !description.isEmpty {
            ideaBlock = "Idea: \(description)"
        } else if !title.isEmpty {
            ideaBlock = "Idea: \(title)"
        } else {
            return userText
        }
        return "\(ideaBlock)\n\n\(userText)"
    }

    private func removeCollaborator(_ member: CachedActor) {
        collaborators.removeAll { $0.actorId == member.actorId }
        agentConfigs.removeValue(forKey: member.actorId)
    }

    /// Starts the sheet on the viewer's default agent. Skipped when the
    /// caller brought its own agents, or the user already chose.
    private func selectDefaultAgent() async {
        guard primaryAgentID == nil, !didChooseAgent,
              !collaborators.contains(where: \.isAgent) else { return }
        var id = defaultAgentID
        if id == nil { id = await actorStore?.getEffectiveDefaultAgent() }
        // A default pointing at an agent the viewer can no longer reach is
        // as good as none.
        guard !didChooseAgent, primaryAgentID == nil,
              let id, agents.contains(where: { $0.id == id }) else { return }
        selectPrimaryAgent(id)
    }

    /// Swaps the primary agent, then seats it in its default workspace once
    /// its own workspace list has loaded.
    private func selectPrimaryAgent(_ agentID: String?) {
        if let old = primaryAgentID {
            collaborators.removeAll { $0.actorId == old }
            agentConfigs.removeValue(forKey: old)
        }
        primaryAgentID = agentID
        guard let agentID else { return }
        if !collaborators.contains(where: { $0.actorId == agentID }) {
            collaborators.insert(cachedActor(forAgentID: agentID), at: 0)
        }
        Task {
            await loadWorkspaces(forAgentID: agentID)
            guard primaryAgentID == agentID, agentConfigs[agentID] == nil else { return }
            if let selection = resolveAgentDefaults(forAgentID: agentID) {
                agentConfigs[agentID] = selection
            }
        }
    }

    private func loadWorkspaces(forAgentID agentID: String) async {
        guard workspacesByAgent[agentID] == nil,
              let workspacesRepository, !teamID.isEmpty else { return }
        loadingWorkspacesFor.insert(agentID)
        defer { loadingWorkspacesFor.remove(agentID) }
        let rows = (try? await workspacesRepository.listWorkspaces(teamID: teamID, agentID: agentID)) ?? []
        workspacesByAgent[agentID] = rows.filter { $0.agentID == nil || $0.agentID == agentID }
    }

    /// The agent's cached actor row, or one built from what the
    /// connected-agents list knows when the cache hasn't caught up.
    private func cachedActor(forAgentID agentID: String) -> CachedActor {
        let descriptor = FetchDescriptor<CachedActor>(predicate: #Predicate { $0.actorId == agentID })
        if let cached = try? modelContext.fetch(descriptor).first { return cached }
        let agent = agents.first { $0.id == agentID }
        return CachedActor(
            actorId: agentID,
            teamId: teamID,
            actorType: "agent",
            displayName: agent?.displayName ?? agentID,
            agentTypes: agent?.agentTypes ?? [],
            defaultAgentType: agent?.defaultAgentType
        )
    }

    private func resolveAgentDefaults(forAgentID agentID: String) -> AgentConfigSheet.Selection? {
        guard let actor = collaborators.first(where: { $0.actorId == agentID }) else { return nil }
        return resolveAgentDefaults(for: actor)
    }

    /// Builds the (workspace, agent type) pair the daemon needs, using the
    /// agent's stored defaults. Prefer the agent's `default_workspace_id`, then
    /// any workspace owned by the agent. Never borrow another agent's path.
    /// Returns nil if no workspace exists for this agent.
    private func resolveAgentDefaults(for actor: CachedActor) -> AgentConfigSheet.Selection? {
        guard let workspaceID = SessionCreationInput.defaultWorkspace(
            agentID: actor.actorId,
            defaultWorkspaceID: actor.defaultWorkspaceId,
            workspaces: (workspacesByAgent[actor.actorId] ?? []) + workspaces
        )?.id else { return nil }
        let allowedTypes = AgentConfigSheet.AgentType.supported(from: actor.agentTypes)
        let defaultType = AgentConfigSheet.AgentType.fromStoredValue(actor.defaultAgentType ?? actor.agentTypes.first)
        let type = allowedTypes.isEmpty || allowedTypes.contains(defaultType) ? defaultType : (allowedTypes.first ?? .pi)
        return AgentConfigSheet.Selection(workspaceID: workspaceID, agentType: type)
    }

    private func sendAndCreate() {
        let userText = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userText.isEmpty else { return }

        let text = firstMessageText(userText: userText)

        isInputFocused = false
        errorMessage = nil
        debugStatusMessage = nil

        // Not connected yet: say so and keep the draft. This used to save a
        // device-only session that the server never heard of, so the next
        // session sync pruned it — and its first message — without a trace.
        guard isAgentAvailable else {
            errorMessage = String(localized: "Not connected yet. Your message is kept — try again in a moment.")
            return
        }
        createSession(text: text, title: userText)
    }

    private var effectiveTeamID: String {
        // Same wire constant as MQTTTopics.normalizedTeamID — this value ends up
        // in the topic path, so it must not follow the brand rename.
        MQTTTopics.normalizedTeamID(teamID)
    }

    /// Returns the routing actor id for the given agent actor (== its id),
    /// resolved from ConnectedAgentsStore.
    private func routeActorID(forAgentActorID actorID: String) -> String {
        guard let agent = connectedAgentsStore?.agents.first(where: { $0.id == actorID }),
              !agent.id.isEmpty
        else { return "" }
        return agent.id
    }

    private func createSession(text: String, title: String) {
        guard let currentActorID else {
            errorMessage = String(localized: "Current actor is not ready yet.")
            return
        }
        guard let teamcluService else {
            errorMessage = String(localized: "Teamclu service is not ready.")
            return
        }

        // Verify all selected agents have reachable daemons before starting.
        for (agentActorID, _) in agentConfigs {
            if routeActorID(forAgentActorID: agentActorID).isEmpty {
                errorMessage = String(localized: "An agent's daemon is offline. Wait for it to reconnect.")
                return
            }
        }

        isSending = true

        let sessionID = UUID().uuidString.lowercased()
        let firstLine = title.split(separator: "\n").first.map(String.init) ?? title
        let trimmedTitle = String(firstLine.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        let createdAt = Date()
        let participantActors = sessionParticipants(currentActorID: currentActorID)
        let participantInfos = sessionInfoParticipants(
            currentActorID: currentActorID,
            createdAt: createdAt,
            participants: participantActors
        )

        let agentSpawns: [SessionCreationInput.AgentSpawn] = agentConfigs.compactMap { agentActorID, cfg in
            let routeActor = routeActorID(forAgentActorID: agentActorID)
            guard !routeActor.isEmpty else { return nil }
            // An app session runs in the agent's checkout of the app; the
            // appBlocker gate has already made sure there is one.
            let checkout = appCheckout(for: agentActorID)
            let workspaceID = checkout?.id ?? cfg.workspaceID
            let wsPath = checkout?.path
                ?? workspaces.first(where: { $0.id == cfg.workspaceID })?.path ?? ""
            return SessionCreationInput.AgentSpawn(
                actorID: agentActorID,
                routeActorID: routeActor,
                workspaceID: workspaceID,
                workspacePath: wsPath,
                agentType: cfg.agentType.asAmuxAgentType
            )
        }

        let mentionIDs = SessionCreationInput.autoMentionAgentIDs(
            agentSpawns: agentSpawns,
            accessibleAgentIDs: Set(connectedAgentsStore?.agents.map(\.id) ?? [])
        )

        let input = SessionCreationInput(
            sessionID: sessionID,
            teamID: effectiveTeamID,
            currentActorID: currentActorID,
            ideaID: selectedIdeaId,
            appID: selectedApp?.id,
            title: trimmedTitle,
            summary: text,
            createdAt: createdAt,
            participants: participantActors.map {
                SessionParticipantInput(
                    actorID: $0.actorId,
                    role: $0.isAgent ? "agent" : "member"
                )
            },
            participantInfos: participantInfos,
            agentSpawns: agentSpawns,
            mentionAgentActorIDs: mentionIDs
        )

        Task {
            guard let repository = sessionsRepository else {
                isSending = false
                errorMessage = String(localized: "Cloud API is not configured.")
                return
            }
            let useCase = SessionCreationUseCase(
                repository: repository,
                teamcluService: teamcluService,
                modelContext: modelContext
            )
            let outcome = await useCase.create(input)

            switch outcome {
            case .created(let sessionID, _):
                viewModel.adoptCreatedSession(sessionID, modelContext: modelContext)
                isSending = false
                newSessionLogger.info(
                    "session created destination=session:\(sessionID, privacy: .public)"
                )
                onSessionCreated?("session:\(sessionID)")
                dismiss()
            case .failed(let failure):
                isSending = false
                errorMessage = failure.userFacingMessage
            }
        }
    }

    private func sessionParticipants(currentActorID: String) -> [CachedActor] {
        var deduped: [String: CachedActor] = collaborators.reduce(into: [:]) { partialResult, actor in
            partialResult[actor.actorId] = actor
        }

        if deduped[currentActorID] == nil {
            deduped[currentActorID] = CachedActor(
                actorId: currentActorID,
                teamId: teamID,
                actorType: "member",
                displayName: teamcluService?.localDisplayName.isEmpty == false ? teamcluService?.localDisplayName ?? currentActorID : currentActorID,
                teamRole: "member"
            )
        }

        return Array(deduped.values)
    }

    private func sessionInfoParticipants(
        currentActorID: String,
        createdAt: Date,
        participants: [CachedActor]
    ) -> [Teamclu_Participant] {
        participants.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            .map { actor in
                var participant = Teamclu_Participant()
                participant.actorID = actor.actorId
                participant.actorType = actor.isAgent ? .personalAgent : .human
                participant.displayName = actor.actorId == currentActorID && !(teamcluService?.localDisplayName ?? "").isEmpty
                    ? teamcluService?.localDisplayName ?? actor.displayName
                    : actor.displayName
                participant.joinedAt = Int64(createdAt.timeIntervalSince1970)
                return participant
            }
    }

}

// MARK: - CachedActor: Identifiable for .sheet(item:)
// CachedActor is a SwiftData @Model and is already Identifiable via actorId.

// MARK: - CollaboratorChip

private struct CollaboratorChip: View {
    let name: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(name)
                .font(.subheadline)
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.semibold))
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
        .foregroundStyle(.primary)
        .liquidGlass(in: Capsule(), interactive: false)
    }
}
