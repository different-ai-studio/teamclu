import Foundation
import Observation
import SwiftData

public extension Notification.Name {
    static let amuxInviteTokenReceived = Notification.Name("amuxInviteTokenReceived")
    static let amuxAuthCallbackReceived = Notification.Name("amuxAuthCallbackReceived")
}

public enum InviteDeepLink {
    /// UserDefaults key under which a cold-launch invite deeplink token is
    /// stashed. At cold launch the `amuxInviteTokenReceived` NotificationCenter
    /// listener (RootView.onReceive) is not mounted yet — the app is still on
    /// the `.loading` route running bootstrap — so a posted notification is
    /// dropped. Persisting the token lets `AppOnboardingCoordinator.bootstrap`
    /// claim the invite BEFORE its auto-create-team branch, instead of stranding
    /// the user in a freshly auto-created throwaway team.
    public static let pendingTokenDefaultsKey = "teamclu.pendingInviteToken"
}

@Observable
@MainActor
public final class ActorStore {
    public private(set) var actors: [ActorRecord] = []
    public private(set) var isLoading = false
    public var errorMessage: String?
    /// FC error code of the last failed op (e.g. "upgrade_required" when a
    /// member invite is blocked because the team is still in the default org).
    public private(set) var lastErrorCode: String?

    private let teamID: String
    private let repository: any ActorRepository
    private let modelContext: ModelContext
    private var lastHeartbeat: Date = .distantPast

    public init(teamID: String, repository: any ActorRepository, modelContext: ModelContext) {
        self.teamID = teamID
        self.repository = repository
        self.modelContext = modelContext
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        // Scope the shared SwiftData cache to the active team up front, before the
        // network fetch, so actors from a previously-viewed team can't leak into
        // the (unscoped) Actors and Members @Query views as phantom members — not
        // even briefly while the fetch is in flight.
        ActorCacheSynchronizer.deleteForeignTeams(currentTeamID: teamID,
                                                  modelContext: modelContext)
        do {
            let remote = try await repository.listActors(teamID: teamID)
            ActorCacheSynchronizer.upsert(remote, modelContext: modelContext)
            ActorCacheSynchronizer.deleteMissing(keeping: Set(remote.map(\.id)),
                                                 teamID: teamID, modelContext: modelContext)
            actors = remote.sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func getJoinLink() async -> TeamJoinLink? {
        do {
            let row = try await repository.getJoinLink(teamID: teamID)
            errorMessage = nil
            lastErrorCode = nil
            return row
        } catch {
            errorMessage = error.localizedDescription
            lastErrorCode = Self.errorCode(error)
            return nil
        }
    }

    @discardableResult
    public func putJoinLink(ttl: TeamJoinLinkTtl, maxUses: Int?, rotate: Bool) async -> TeamJoinLink? {
        do {
            let row = try await repository.putJoinLink(
                teamID: teamID,
                input: TeamJoinLinkInput(ttl: ttl, maxUses: maxUses, rotate: rotate)
            )
            errorMessage = nil
            lastErrorCode = nil
            return row
        } catch {
            errorMessage = error.localizedDescription
            lastErrorCode = Self.errorCode(error)
            return nil
        }
    }

    @discardableResult
    public func revokeJoinLink() async -> Bool {
        do {
            try await repository.revokeJoinLink(teamID: teamID)
            errorMessage = nil
            lastErrorCode = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            lastErrorCode = Self.errorCode(error)
            return false
        }
    }

    @discardableResult
    public func joinByLink(token: String, cloudAPIURL: URL?) async -> JoinByLinkResult? {
        do {
            let row = try await repository.joinByLink(token: token, cloudAPIURL: cloudAPIURL)
            errorMessage = nil
            lastErrorCode = nil
            return row
        } catch {
            errorMessage = error.localizedDescription
            lastErrorCode = Self.errorCode(error)
            return nil
        }
    }

    @discardableResult
    public func createInvite(_ input: InviteCreateInput) async -> InviteCreated? {
        do {
            let r = try await repository.createInvite(teamID: teamID, input: input)
            errorMessage = nil
            lastErrorCode = nil
            return r
        } catch {
            errorMessage = error.localizedDescription
            lastErrorCode = Self.errorCode(error)
            return nil
        }
    }

    /// Graduate the account into its own org (org name + contact). Returns the
    /// new team name on success, or nil (with errorMessage set) on failure.
    public func upgradeAccount(orgName: String, contact: String?) async -> OrgUpgradeResult? {
        do {
            let r = try await repository.upgradeAccount(teamID: teamID, orgName: orgName, contact: contact)
            errorMessage = nil
            lastErrorCode = nil
            return r
        } catch {
            errorMessage = error.localizedDescription
            lastErrorCode = Self.errorCode(error)
            return nil
        }
    }

    /// Extract the FC error code from a CloudAPIError, if present.
    private static func errorCode(_ error: Error) -> String? {
        if case let CloudAPIError.requestFailed(_, code, _) = error { return code }
        return nil
    }

    @discardableResult
    public func claimInvite(token: String) async -> ClaimResult? {
        do {
            let r = try await repository.claimInvite(token: token)
            await reload()
            return r
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    public func heartbeat() async {
        guard Date().timeIntervalSince(lastHeartbeat) > 30 else { return }
        lastHeartbeat = Date()
        do { try await repository.heartbeat() } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Returns true on success. On failure the error message is set on the store.
    @discardableResult
    public func removeActor(actorID: String) async -> Bool {
        do {
            try await repository.removeActor(actorID: actorID)
            await reload()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Updates an agent's stored defaults (workspace, agent_kind, default_agent_type).
    /// Any nil argument leaves the existing value untouched. Refreshes the local cache on success.
    @discardableResult
    public func updateAgentDefaults(
        actorID: String,
        defaultWorkspaceID: String?,
        agentKind: String?,
        defaultAgentType: String?
    ) async -> AgentDefaults? {
        do {
            let updated = try await repository.updateAgentDefaults(
                actorID: actorID,
                defaultWorkspaceID: defaultWorkspaceID,
                agentKind: agentKind,
                defaultAgentType: defaultAgentType
            )
            await reload()
            return updated
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// The current member's default agent id for this team (nil if unset or on error).
    public func getMemberDefaultAgent() async -> String? {
        do {
            let id = try await repository.getMemberDefaultAgent(teamID: teamID)
            errorMessage = nil
            return id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Sets (agentID) or clears (nil) the current member's default agent.
    /// Returns the new value on success, or nil on failure (error set on the store).
    /// The Bool out-param distinguishes a successful clear (nil value) from a failure.
    @discardableResult
    public func setMemberDefaultAgent(agentID: String?) async -> (ok: Bool, value: String?) {
        do {
            let value = try await repository.setMemberDefaultAgent(teamID: teamID, agentID: agentID)
            errorMessage = nil
            return (true, value)
        } catch {
            errorMessage = error.localizedDescription
            return (false, nil)
        }
    }

    /// The team-level default agent id (nil if unset or on error).
    public func getTeamDefaultAgent() async -> String? {
        do {
            let id = try await repository.getTeamDefaultAgent(teamID: teamID)
            errorMessage = nil
            return id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Sets (agentID) or clears (nil) the team default agent. Owner/admin only (server-enforced).
    /// Returns the new value on success, or nil on failure (error set on the store).
    @discardableResult
    public func setTeamDefaultAgent(agentID: String?) async -> (ok: Bool, value: String?) {
        do {
            let value = try await repository.setTeamDefaultAgent(teamID: teamID, agentID: agentID)
            errorMessage = nil
            return (true, value)
        } catch {
            errorMessage = error.localizedDescription
            return (false, nil)
        }
    }

    /// The calling member's effective default agent (member default, else team default, else nil).
    public func getEffectiveDefaultAgent() async -> String? {
        do {
            let id = try await repository.getEffectiveDefaultAgent(teamID: teamID)
            errorMessage = nil
            return id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
