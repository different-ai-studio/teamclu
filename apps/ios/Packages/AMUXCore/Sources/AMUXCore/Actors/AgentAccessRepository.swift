import Foundation

public protocol AgentAccessRepository: Sendable {
    /// Every agent the *current* auth user has a row in `agent_member_access` for,
    /// scoped to a specific team.
    func listConnectedAgents(teamID: String) async throws -> [ConnectedAgent]

    /// Every human actor authorized on `agentID`, with their permission level.
    func listAuthorizedHumans(agentID: String) async throws -> [AgentAuthorizedHuman]

    /// Whether the current auth user can manage agent-member access for a team.
    func canManageAuthorizedHumans(agentID: String) async throws -> Bool

    /// Grant access for a member on an agent, upserting if the relationship already exists.
    func grantAuthorizedHuman(agentID: String, memberID: String, permissionLevel: String) async throws

    /// Make an owned personal agent visible in the team Actors directory.
    func shareAgentToTeam(agentID: String) async throws

    /// Hide an owned team agent from the Actors directory and revoke non-owner grants.
    func makeAgentPersonal(agentID: String) async throws

    /// Total number of agent actors in this team (regardless of which member
    /// has access). Used to decide whether to show the "add the team's first
    /// agent" reminder.
    func teamAgentCount(teamID: String) async throws -> Int
}

