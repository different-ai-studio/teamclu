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

    let viewModel: SessionListViewModel
    let preselectedIdeaId: String?
    let preselectedCollaborators: [CachedActor]

    // Per-agent config (workspace + agent type) keyed by actorId. Resolved
    // automatically from each agent's stored defaults when they're tapped in
    // the picker — no per-session prompt.
    @State private var agentConfigs: [String: AgentConfigSheet.Selection] = [:]
    @State private var workspaceStore: WorkspaceStore?

    @State private var collaborators: [CachedActor] = []
    @State private var selectedIdeaId: String?
    @State private var messageText: String = ""
    @State private var showMemberPicker = false
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var debugStatusMessage: String?
    @State private var debugTransportMessage: String?
    @FocusState private var isInputFocused: Bool

    @Query(filter: #Predicate<SessionIdea> { !$0.archived },
           sort: \SessionIdea.createdAt, order: .reverse)
    private var ideas: [SessionIdea]

    private var workspaces: [WorkspaceRecord] { workspaceStore?.workspaces ?? [] }
    private var availableIdeas: [SessionIdea] { ideas }

    /// Set by parent — called with agentId when session is created
    var onSessionCreated: ((String) -> Void)?

    public init(mqtt: MQTTService, peerId: String, teamcluService: TeamcluService? = nil,
                teamID: String = "", currentActorID: String? = nil, isAgentAvailable: Bool = true,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                actorStore: ActorStore? = nil,
                agentPresenceStore: AgentPresenceStore? = nil,
                workspacesRepository: (any WorkspaceRepository)? = nil,
                sessionsRepository: (any SessionRepository)? = nil,
                viewModel: SessionListViewModel,
                preselectedIdeaId: String? = nil,
                preselectedCollaborators: [CachedActor] = [],
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
        self.viewModel = viewModel
        self.preselectedIdeaId = preselectedIdeaId
        self.preselectedCollaborators = preselectedCollaborators
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
        return textOK && hasOtherActor && agentsConfigured
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Color.amux.mist.ignoresSafeArea()
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            collaboratorsSection
                            ideaSection
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
            .navigationBarTitleDisplayMode(.large)
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
                    } else if let selection = resolveAgentDefaults(for: actor) {
                        agentConfigs[actor.actorId] = selection
                        if !collaborators.contains(where: { $0.actorId == actor.actorId }) {
                            collaborators.append(actor)
                        }
                    } else {
                        return String(localized: "This agent has no workspace. Add one in Agent settings.")
                    }
                    return nil
                }
            ) { selected in
                // `selected` includes humans (from internal selectedIDs) +
                // agents already added via auto-config (passed in via
                // externallySelectedIDs). Replace collaborators wholesale.
                collaborators = selected
            }
            .task { await connectedAgentsStore?.reload() }
        }
        .task { await connectedAgentsStore?.reload() }
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

    // MARK: - Collaborators section

    private var collaboratorsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HaiSectionLabel(String(localized: "Collaborators"))
            HaiPaperCard {
                Button {
                    showMemberPicker = true
                    isInputFocused = false
                } label: {
                    HStack(spacing: 10) {
                        if collaborators.isEmpty {
                            Text("Just you")
                                .font(.system(size: 14.5))
                                .foregroundStyle(Color.amux.basalt.opacity(0.6))
                        } else {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(collaborators, id: \.actorId) { member in
                                        CollaboratorChip(name: member.displayName) {
                                            removeCollaborator(member)
                                        }
                                    }
                                }
                                .padding(.vertical, 1)
                            }
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.amux.slate)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 13)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Idea section

    private var ideaSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HaiSectionLabel(IdeaUIPresentation.singularTitle)
            HaiPaperCard {
                Menu {
                    Button {
                        selectedIdeaId = nil
                    } label: {
                        Label("None", systemImage: selectedIdeaId == nil ? "checkmark" : "circle")
                    }
                    if !availableIdeas.isEmpty {
                        Divider()
                        ForEach(availableIdeas, id: \.ideaId) { item in
                            Button {
                                selectedIdeaId = item.ideaId
                            } label: {
                                Label(item.displayTitle,
                                      systemImage: selectedIdeaId == item.ideaId ? "checkmark" : "circle")
                            }
                        }
                    }
                } label: {
                    HaiSheetRow(
                        label: IdeaUIPresentation.singularTitle,
                        value: selectedIdeaLabel,
                        valueIsMuted: selectedIdeaId == nil,
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var selectedIdeaLabel: String {
        if let id = selectedIdeaId,
           let item = ideas.first(where: { $0.ideaId == id }) {
            return item.displayTitle
        }
        return String(localized: "None")
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

    /// Builds the (workspace, agent type) pair the daemon needs, using the
    /// agent's stored defaults. Prefer the agent's `default_workspace_id`, then
    /// any workspace owned by the agent. Never borrow another agent's path.
    /// Returns nil if no workspace exists for this agent.
    private func resolveAgentDefaults(for actor: CachedActor) -> AgentConfigSheet.Selection? {
        let owned = workspaces.filter { $0.agentID == actor.actorId }
        let workspaceID: String? = {
            if let id = actor.defaultWorkspaceId,
               workspaces.contains(where: { $0.id == id }) {
                return id
            }
            return owned.first?.id
        }()
        guard let workspaceID else { return nil }
        let allowedTypes = AgentConfigSheet.AgentType.supported(from: actor.agentTypes)
        let defaultType = AgentConfigSheet.AgentType.fromStoredValue(actor.defaultAgentType ?? actor.agentTypes.first)
        let type = allowedTypes.isEmpty || allowedTypes.contains(defaultType) ? defaultType : (allowedTypes.first ?? .claude)
        return AgentConfigSheet.Selection(workspaceID: workspaceID, agentType: type)
    }

    private func sendAndCreate() {
        let userText = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !userText.isEmpty else { return }

        let text = firstMessageText(userText: userText)

        isInputFocused = false
        errorMessage = nil
        debugStatusMessage = nil

        if !isAgentAvailable {
            createLocalSession(text: text, title: userText)
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
            let wsPath = workspaces.first(where: { $0.id == cfg.workspaceID })?.path ?? ""
            return SessionCreationInput.AgentSpawn(
                actorID: agentActorID,
                routeActorID: routeActor,
                workspaceID: cfg.workspaceID,
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
                viewModel.reloadSessions(modelContext: modelContext)
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

    private func createLocalSession(text: String, title: String) {
        guard let currentActorID else {
            errorMessage = String(localized: "Current actor is not ready yet.")
            return
        }

        let createdAt = Date()
        let sessionID = UUID().uuidString
        let session = Session(
            sessionId: sessionID,
            teamId: teamID,
            title: String((title.split(separator: "\n").first.map(String.init) ?? title).trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)),
            createdBy: currentActorID,
            createdAt: createdAt,
            summary: text,
            participantCount: max(collaborators.count + 1, 1),
            lastMessagePreview: text,
            lastMessageAt: createdAt,
            ideaId: selectedIdeaId ?? ""
        )

        let message = SessionMessage(
            messageId: UUID().uuidString,
            sessionId: sessionID,
            senderActorId: currentActorID,
            kind: "text",
            content: text,
            createdAt: createdAt
        )

        modelContext.insert(session)
        modelContext.insert(message)
        try? modelContext.save()
        viewModel.reloadSessions(modelContext: modelContext)
        onSessionCreated?("session:\(sessionID)")
        dismiss()
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
