import Foundation
import SwiftData
import AMUXCore

/// Starts a new session from a completed voice transcript. This is deliberately
/// stricter than the manual new-session sheet: voice always addresses the
/// viewer's effective default agent, so it must not fall back to a human-only
/// local session when that agent or its workspace is unavailable.
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

    static func start(
        transcript: String,
        teamID: String,
        currentActorID: String?,
        teamcluService: TeamcluService?,
        actorStore: ActorStore?,
        connectedAgentsStore: ConnectedAgentsStore?,
        workspacesRepository: (any WorkspaceRepository)?,
        sessionsRepository: (any SessionRepository)?,
        viewModel: SessionListViewModel,
        modelContext: ModelContext
    ) async throws -> String {
        let prompt = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { throw StartError.transcriptEmpty }
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

        await connectedAgentsStore.reload()
        guard let defaultAgentID = await actorStore.getEffectiveDefaultAgent(),
              let agent = connectedAgentsStore.agents.first(where: { $0.id == defaultAgentID })
        else {
            throw StartError.unavailable(String(localized: "Set an available default agent before starting voice chat."))
        }

        let workspaceStore = WorkspaceStore(teamID: teamID, repository: workspacesRepository)
        await workspaceStore.reload(agentID: agent.id)
        guard let workspace = workspaceStore.workspaces.first else {
            throw StartError.unavailable(String(localized: "Your default agent has no workspace. Add one in Agent settings."))
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
            agentSpawns: [.init(
                actorID: agent.id,
                routeActorID: agent.id,
                workspaceID: workspace.id,
                workspacePath: workspace.path,
                agentType: agentType.asAmuxAgentType
            )],
            mentionAgentActorIDs: [agent.id]
        )

        let outcome = await SessionCreationUseCase(
            repository: sessionsRepository,
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
