import Foundation
import SwiftData

@MainActor
public enum ActorCacheSynchronizer {
    public static func upsert(_ records: [ActorRecord], modelContext: ModelContext) {
        for r in records { upsert(r, modelContext: modelContext) }
        try? modelContext.save()
    }

    public static func upsert(_ record: ActorRecord, modelContext: ModelContext) {
        let descriptor = FetchDescriptor<CachedActor>(
            predicate: #Predicate { $0.actorId == record.id }
        )
        if let existing = try? modelContext.fetch(descriptor).first {
            existing.teamId           = record.teamID
            existing.actorType        = record.actorType
            existing.userId           = record.userID
            existing.invitedByActorId = record.invitedByActorID
            existing.displayName      = record.displayName
            existing.avatarURL        = record.avatarURL
            existing.lastActiveAt     = record.lastActiveAt
            existing.createdAt        = record.createdAt
            existing.updatedAt        = record.updatedAt
            existing.memberStatus     = record.memberStatus
            existing.roles            = record.roles
            existing.teamRole         = record.teamRole
            existing.agentTypes         = record.agentTypes
            existing.agentKind          = record.agentKind
            existing.defaultAgentType   = record.defaultAgentType
            existing.agentStatus        = record.agentStatus
            existing.defaultWorkspaceId = record.defaultWorkspaceID
            existing.email              = record.email
            existing.phone              = record.phone
        } else {
            modelContext.insert(CachedActor(
                actorId: record.id, teamId: record.teamID,
                actorType: record.actorType, userId: record.userID,
                invitedByActorId: record.invitedByActorID,
                displayName: record.displayName,
                avatarURL: record.avatarURL,
                lastActiveAt: record.lastActiveAt,
                createdAt: record.createdAt, updatedAt: record.updatedAt,
                memberStatus: record.memberStatus, roles: record.roles, teamRole: record.teamRole,
                agentTypes: record.agentTypes, agentKind: record.agentKind, defaultAgentType: record.defaultAgentType,
                agentStatus: record.agentStatus, defaultWorkspaceId: record.defaultWorkspaceID,
                email: record.email, phone: record.phone
            ))
        }
    }

    public static func deleteMissing(keeping ids: Set<String>, teamID: String,
                                     modelContext: ModelContext) {
        let descriptor = FetchDescriptor<CachedActor>(
            predicate: #Predicate { $0.teamId == teamID }
        )
        guard let all = try? modelContext.fetch(descriptor) else { return }
        for row in all where !ids.contains(row.actorId) {
            modelContext.delete(row)
        }
        try? modelContext.save()
    }

    /// Drop every cached actor that does NOT belong to `teamID`.
    ///
    /// The app shows one active team at a time, but the SwiftData store is a
    /// single shared cache: actors from a previously-viewed team linger after a
    /// team switch. The Actors/Members views query `CachedActor` without a team
    /// predicate, so those leftovers show up as phantom members of the current
    /// team. Purging foreign-team rows on every reload keeps the cache scoped to
    /// the active team and makes all those unscoped queries correct.
    public static func deleteForeignTeams(currentTeamID teamID: String,
                                          modelContext: ModelContext) {
        let descriptor = FetchDescriptor<CachedActor>(
            predicate: #Predicate { $0.teamId != teamID }
        )
        guard let foreign = try? modelContext.fetch(descriptor) else { return }
        guard !foreign.isEmpty else { return }
        for row in foreign {
            modelContext.delete(row)
        }
        try? modelContext.save()
    }
}
