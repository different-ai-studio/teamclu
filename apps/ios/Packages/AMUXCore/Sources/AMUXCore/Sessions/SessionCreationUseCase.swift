import Foundation
import SwiftData

// MARK: - Use case I/O types

/// Inputs for the agent-backed session-creation flow. Pre-resolved at the
/// call site (`NewSessionSheet`) so the use case sees concrete identifiers
/// and doesn't need to touch SwiftData or `ConnectedAgentsStore`.
public struct SessionCreationInput: Sendable {
    public let sessionID: String
    public let teamID: String
    public let currentActorID: String
    public let ideaID: String?
    public let title: String
    public let summary: String
    public let createdAt: Date
    public let participants: [SessionParticipantInput]
    /// Pre-built protobuf participants used by the local cache persist
    /// step (it builds a Teamclu_SessionInfo to seed the SwiftData row
    /// without round-tripping through the daemon). Mirrors `participants`
    /// but carries the display-name attribution the local cache wants to
    /// show immediately.
    public let participantInfos: [Teamclu_Participant]
    /// Agents to spawn after the first message lands. Empty for human-
    /// only sessions (which take the simpler local-only path elsewhere
    /// and don't reach this use case).
    public let agentSpawns: [AgentSpawn]
    /// Mention list stamped onto the first message. Build it with
    /// `autoMentionAgentIDs(agentSpawns:accessibleAgentIDs:)` so every
    /// entry point applies the same rule. Also seeds the session's lit
    /// agent chips, so follow-up sends keep engaging the same agents.
    public let mentionAgentActorIDs: [String]

    public struct AgentSpawn: Sendable {
        public let actorID: String
        public let routeActorID: String
        public let workspaceID: String
        public let workspacePath: String
        public let agentType: Amux_AgentType

        public init(actorID: String, routeActorID: String, workspaceID: String,
                    workspacePath: String, agentType: Amux_AgentType) {
            self.actorID = actorID
            self.routeActorID = routeActorID
            self.workspaceID = workspaceID
            self.workspacePath = workspacePath
            self.agentType = agentType
        }
    }

    public init(sessionID: String, teamID: String, currentActorID: String,
                ideaID: String?, title: String, summary: String, createdAt: Date,
                participants: [SessionParticipantInput],
                participantInfos: [Teamclu_Participant],
                agentSpawns: [AgentSpawn],
                mentionAgentActorIDs: [String]) {
        self.sessionID = sessionID
        self.teamID = teamID
        self.currentActorID = currentActorID
        self.ideaID = ideaID
        self.title = title
        self.summary = summary
        self.createdAt = createdAt
        self.participants = participants
        self.participantInfos = participantInfos
        self.agentSpawns = agentSpawns
        self.mentionAgentActorIDs = mentionAgentActorIDs
    }

    /// Who the first message mentions. Exactly one agent that the viewer can
    /// reach (`accessibleAgentIDs` — the ConnectedAgentsStore roster) is
    /// mentioned automatically; several agents, or one the viewer has no
    /// grant on, mention nobody and the user picks with @ in the session.
    ///
    /// Without a mention the daemon silent-queues the message, so a spawned
    /// runtime would show "starting" and then never reply.
    public static func autoMentionAgentIDs(agentSpawns: [AgentSpawn],
                                           accessibleAgentIDs: Set<String>) -> [String] {
        guard agentSpawns.count == 1, let only = agentSpawns.first,
              accessibleAgentIDs.contains(only.actorID)
        else { return [] }
        return [only.actorID]
    }

    /// First-message body: `@<displayName> ` prepended for each mentioned
    /// agent not already named inline — the same shape the in-session
    /// composer sends (`SessionDetailViewModel.composeBodyWithMentions`), so
    /// the chat history shows who the message was addressed to.
    public var firstMessageContent: String {
        var body = summary
        for agentID in mentionAgentActorIDs {
            guard let name = participantInfos.first(where: { $0.actorID == agentID })?.displayName,
                  !name.isEmpty
            else { continue }
            let token = "@\(name)"
            if !body.localizedCaseInsensitiveContains(token) {
                body = body.isEmpty ? token : "\(token) \(body)"
            }
        }
        return body
    }
}

public enum SessionCreationOutcome: Sendable {
    case created(sessionID: String, partial: SessionCreationPartial?)
    case failed(SessionCreationFailure)
}

/// Non-fatal degradations: the session exists and is navigable, but some
/// downstream step did not complete. The view should land the user on the
/// session and surface a non-blocking banner; failure-mode UX must not
/// roll the session back, since it is already persisted in Supabase.
///
/// `runtimeStart` outcomes are intentionally absent: per-agent spawns
/// fire in detached tasks so the sheet can dismiss before ACP bring-up
/// (~6s per daemon). The chip bar in the destination view reflects
/// the attachment's status (yellow=spawning → green=active → red=failed),
/// which is the source of truth for per-agent spawn state.
public struct SessionCreationPartial: Sendable {
    /// false when local persistence succeeded but the MQTT publish for
    /// the first message failed — the message lives in the outbox and
    /// will retry on next reconnect.
    public let firstMessagePersisted: Bool

    public init(firstMessagePersisted: Bool) {
        self.firstMessagePersisted = firstMessagePersisted
    }

    /// True when every downstream step the use case can observe landed
    /// cleanly — used by the caller to decide whether to suppress the
    /// banner entirely.
    public var isCleanSuccess: Bool { firstMessagePersisted }
}

public enum SessionCreationFailure: Sendable {
    /// Supabase `INSERT sessions` failed — no session row exists; the
    /// view should stay on the sheet for retry.
    case supabaseCreate(String)
    /// Local SwiftData persistence failed for the session row.
    /// (Subscribe-live is fire-and-forget on `TeamcluService` and
    /// can't surface a failure here today; intentionally absent.)
    case localCachePersist(String)
    /// First-message persist + publish both failed (i.e. nothing went
    /// to Supabase or the outbox). Distinct from a publish-only failure,
    /// which is surfaced via `partial.firstMessagePersisted == false`.
    case firstMessageRejected(sessionID: String, String)

    /// Single-line message suitable for inline display under the composer.
    /// The internal detail is the underlying error's `localizedDescription`
    /// captured at throw time.
    public var userFacingMessage: String {
        switch self {
        case .supabaseCreate(let msg),
             .localCachePersist(let msg),
             .firstMessageRejected(_, let msg):
            return msg
        }
    }
}

// MARK: - Use case

/// Orchestrates the six-step new-session flow that used to live inline in
/// `NewSessionSheet.createSession`:
///
/// 1. Create the Supabase `sessions` + `session_participants` rows.
/// 2. Subscribe to `session/{id}/live` so live events aren't missed.
/// 3. Persist the local SwiftData `Session` row.
/// 4. Persist + publish the first message (`persistFirst: true` so the
///    daemon's post-spawn catchup finds the row even if MQTT raced).
/// 5. Spawn each agent runtime via `runtimeStart` RPC (best-effort).
/// 6. Return the outcome so the caller can navigate.
///
/// The view passes the use case's outcome straight back through to
/// navigation: `.created` dismisses the sheet and pushes session detail;
/// `.failed` stays on the sheet with `errorMessage` set.
@MainActor
public final class SessionCreationUseCase {
    private let repository: SessionRepository
    private let teamcluService: TeamcluService
    private let modelContext: ModelContext

    public init(repository: SessionRepository,
                teamcluService: TeamcluService,
                modelContext: ModelContext) {
        self.repository = repository
        self.teamcluService = teamcluService
        self.modelContext = modelContext
    }

    public func create(_ input: SessionCreationInput) async -> SessionCreationOutcome {
        // Step 1: Supabase create. Hard failure — without this row, no
        // other step can do useful work.
        do {
            try await repository.createSession(
                SessionCreateInput(
                    id: input.sessionID,
                    teamID: input.teamID,
                    ideaID: input.ideaID,
                    createdByActorID: input.currentActorID,
                    primaryAgentID: nil,
                    title: input.title,
                    summary: input.summary,
                    participants: input.participants
                )
            )
        } catch {
            return .failed(.supabaseCreate(error.localizedDescription))
        }

        // Step 2: Subscribe live before spawning so no events are missed.
        // TeamcluService.subscribeToSession is fire-and-forget; we can't
        // surface a failure here. Best-effort.
        teamcluService.subscribeToSession(input.sessionID)

        // Step 3: Local cache persist. Hard failure — without the local
        // row, navigation to the detail view would land on an empty state.
        do {
            try persistLocalSession(input)
        } catch {
            return .failed(.localCachePersist(error.localizedDescription))
        }

        // Step 4: First message. `persistFirst: true` writes to Supabase
        // BEFORE publishing so the daemon's post-spawn catchup query finds
        // it even if MQTT raced ahead of the daemon's subscribe.
        //
        // Split failure semantics, target shape: persist+publish both fail
        // → hard failure; persist succeeded but publish failed → partial
        // with `firstMessagePersisted = false`. Today the underlying
        // TeamcluService.sendMessage only throws on Supabase write fail,
        // so the "publish failed only" path falls through to a successful
        // return and the outbox picks it up invisibly here. The partial
        // type stays in the API for when the split is plumbed through.
        do {
            _ = try await teamcluService.sendMessage(
                sessionId: input.sessionID,
                content: input.firstMessageContent,
                mentionActorIDs: input.mentionAgentActorIDs,
                persistFirst: true
            )
        } catch {
            return .failed(.firstMessageRejected(sessionID: input.sessionID,
                                                error.localizedDescription))
        }

        // Step 5: Spawn agent runtimes in detached tasks — fire-and-forget
        // so the sheet dismisses immediately and the user lands on the
        // session detail right away. The daemon takes ~6s per agent to
        // bring ACP up; spawn outcomes manifest via the actor retain
        // status updates that the chip bar reflects directly.
        spawnRuntimes(input)

        return .created(sessionID: input.sessionID, partial: nil)
    }

    // MARK: - Steps 3 & 5

    private func persistLocalSession(_ input: SessionCreationInput) throws {
        let sessionID = input.sessionID
        let fetch = FetchDescriptor<Session>(
            predicate: #Predicate { $0.sessionId == sessionID }
        )
        let session = (try? modelContext.fetch(fetch))?.first ?? {
            let newSession = Session(
                sessionId: input.sessionID,
                teamId: input.teamID,
                title: input.title,
                createdBy: input.currentActorID,
                createdAt: input.createdAt,
                summary: input.summary,
                participantCount: input.participantInfos.count,
                lastMessagePreview: input.summary,
                lastMessageAt: nil,
                ideaId: input.ideaID ?? ""
            )
            modelContext.insert(newSession)
            return newSession
        }()

        session.teamId = input.teamID
        session.title = input.title
        session.createdBy = input.currentActorID
        session.createdAt = input.createdAt
        session.summary = input.summary
        session.participantCount = input.participantInfos.count
        session.lastMessagePreview = input.summary
        session.lastMessageAt = nil
        session.ideaId = input.ideaID ?? ""
        session.primaryAgentId = nil
        session.selectedAgentIds = input.mentionAgentActorIDs.sorted()
        try modelContext.save()
    }

    private func spawnRuntimes(_ input: SessionCreationInput) {
        let service = teamcluService
        let sessionID = input.sessionID
        for spawn in input.agentSpawns {
            Task.detached {
                _ = await service.runtimeStartRpc(
                    targetActorID: spawn.routeActorID,
                    agentType: spawn.agentType,
                    workspaceId: spawn.workspaceID,
                    worktree: spawn.workspacePath,
                    sessionId: sessionID,
                    initialPrompt: ""
                )
            }
        }
    }
}
