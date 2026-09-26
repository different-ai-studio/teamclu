import Foundation
import SwiftData
import AMUXCore

/// Starts a new session from a completed voice transcript. This is deliberately
/// stricter than the manual new-session sheet: voice always addresses a single
/// agent, so it must not fall back to a human-only local session when that
/// agent or its workspace is unavailable.
///
/// Two steps, because the middle of them may need the user: `resolveTarget`
/// works out which agent the take belongs to — the viewer's effective default
/// when there is one, otherwise the list to offer in a picker — and `start`
/// creates the session once an agent is settled.
@MainActor
enum VoiceSessionStarter {
    enum StartError: LocalizedError {
        case transcriptEmpty
        case unavailable(String)

        var errorDescription: String? {
            switch self {
            case .transcriptEmpty:
                String(localized: "No speech was recognized. Try recording again.")
            case .unavailable(let message):
                message
            }
        }
    }

    /// Everything a take needs, unwrapped once so neither agent resolution
    /// nor session creation has to re-check it.
    struct Context {
        let teamID: String
        let currentActorID: String
        let teamcluService: TeamcluService
        let actorStore: ActorStore
        let connectedAgentsStore: ConnectedAgentsStore
        let workspacesRepository: any WorkspaceRepository
        let sessionsRepository: any SessionRepository

        init(teamID: String,
             currentActorID: String?,
             teamcluService: TeamcluService?,
             actorStore: ActorStore?,
             connectedAgentsStore: ConnectedAgentsStore?,
             workspacesRepository: (any WorkspaceRepository)?,
             sessionsRepository: (any SessionRepository)?) throws {
            guard !teamID.isEmpty,
                  let currentActorID,
                  let teamcluService,
                  let actorStore,
                  let connectedAgentsStore,
                  let workspacesRepository,
                  let sessionsRepository
            else {
                throw StartError.unavailable(String(localized: "Voice chat is not ready yet."))
            }
            self.teamID = teamID
            self.currentActorID = currentActorID
            self.teamcluService = teamcluService
            self.actorStore = actorStore
            self.connectedAgentsStore = connectedAgentsStore
            self.workspacesRepository = workspacesRepository
            self.sessionsRepository = sessionsRepository
        }
    }

    /// Who the transcript goes to.
    enum Target {
        case agent(ConnectedAgent)
        /// No usable default — the caller asks the user to pick from these
        /// (never empty) and passes the choice to `start`.
        case needsPick([ConnectedAgent])
    }

    static func resolveTarget(_ context: Context) async throws -> Target {
        await context.connectedAgentsStore.reload()
        let agents = context.connectedAgentsStore.agents
        guard !agents.isEmpty else {
            throw StartError.unavailable(String(localized: "Add an agent before starting voice chat."))
        }
        // A default pointing at an agent the viewer can no longer reach is as
        // good as no default, so it falls through to the picker — whose
        // choice then overwrites the stale pointer.
        if let defaultAgentID = await context.actorStore.getEffectiveDefaultAgent(),
           let agent = agents.first(where: { $0.id == defaultAgentID }) {
            return .agent(agent)
        }
        return .needsPick(agents)
    }

    static func start(
        transcript: String,
        agent: ConnectedAgent,
        context: Context,
        viewModel: SessionListViewModel,
        modelContext: ModelContext
    ) async throws -> String {
        let prompt = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { throw StartError.transcriptEmpty }
        let teamID = context.teamID
        let currentActorID = context.currentActorID
        let teamcluService = context.teamcluService

        let workspaceStore = WorkspaceStore(teamID: teamID, repository: context.workspacesRepository)
        await workspaceStore.reload(agentID: agent.id)
        guard let workspace = workspaceStore.workspaces.first else {
            throw StartError.unavailable(String(localized: "This agent has no workspace. Add one in Agent settings."))
        }

        let agentType = AgentConfigSheet.AgentType.fromStoredValue(
            agent.defaultAgentType ?? agent.agentTypes.first
        )
        let createdAt = Date()
        let sessionID = UUID().uuidString.lowercased()
        let title = String(prompt.split(separator: "\n").first.map(String.init)?.prefix(80) ?? prompt.prefix(80))
        let participants = [
            SessionParticipantInput(actorID: currentActorID, role: "member"),
            SessionParticipantInput(actorID: agent.id, role: "agent"),
        ]
        let participantInfos = [
            participant(actorID: currentActorID, type: .human,
                        displayName: teamcluService.localDisplayName.isEmpty ? currentActorID : teamcluService.localDisplayName,
                        joinedAt: createdAt),
            participant(actorID: agent.id, type: .personalAgent,
                        displayName: agent.displayName, joinedAt: createdAt),
        ]
        let agentSpawns: [SessionCreationInput.AgentSpawn] = [.init(
            actorID: agent.id,
            routeActorID: agent.id,
            workspaceID: workspace.id,
            workspacePath: workspace.path,
            agentType: agentType.asAmuxAgentType
        )]
        let input = SessionCreationInput(
            sessionID: sessionID,
            teamID: MQTTTopics.normalizedTeamID(teamID),
            currentActorID: currentActorID,
            ideaID: nil,
            title: title,
            summary: prompt,
            createdAt: createdAt,
            participants: participants,
            participantInfos: participantInfos,
            agentSpawns: agentSpawns,
            mentionAgentActorIDs: SessionCreationInput.autoMentionAgentIDs(
                agentSpawns: agentSpawns,
                accessibleAgentIDs: Set(context.connectedAgentsStore.agents.map(\.id))
            )
        )

        let outcome = await SessionCreationUseCase(
            repository: context.sessionsRepository,
            teamcluService: teamcluService,
            modelContext: modelContext
        ).create(input)
        switch outcome {
        case .created(let createdID, _):
            viewModel.reloadSessions(modelContext: modelContext)
            return createdID
        case .failed(let failure):
            throw StartError.unavailable(failure.userFacingMessage)
        }
    }

    private static func participant(
        actorID: String,
        type: Teamclu_ActorType,
        displayName: String,
        joinedAt: Date
    ) -> Teamclu_Participant {
        var participant = Teamclu_Participant()
        participant.actorID = actorID
        participant.actorType = type
        participant.displayName = displayName
        participant.joinedAt = Int64(joinedAt.timeIntervalSince1970)
        return participant
    }
}
