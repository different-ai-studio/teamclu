import Foundation
import SwiftData

@MainActor
public enum IdeaCacheSynchronizer {
    public static func upsert(_ ideas: [IdeaRecord], modelContext: ModelContext) {
        for idea in ideas {
            upsert(idea, modelContext: modelContext)
        }

        try? modelContext.save()
    }

    public static func upsert(_ idea: IdeaRecord, modelContext: ModelContext) {
        let descriptor = FetchDescriptor<SessionIdea>(
            predicate: #Predicate { $0.ideaId == idea.id }
        )

        if let existing = try? modelContext.fetch(descriptor).first {
            existing.workspaceId = idea.workspaceID
            existing.title = idea.title
            existing.ideaDescription = idea.description
            existing.status = idea.status
            existing.createdBy = idea.createdByActorID
            existing.createdAt = idea.createdAt
            existing.archived = idea.archived
            existing.sortOrder = idea.sortOrder
            existing.teamId = idea.teamID
            existing.updatedAt = idea.updatedAt
            existing.attachmentURLsJSON = encodeURLs(idea.attachmentURLs)
        } else {
            let row = SessionIdea(
                ideaId: idea.id,
                sessionId: "",
                workspaceId: idea.workspaceID,
                title: idea.title,
                ideaDescription: idea.description,
                status: idea.status,
                parentIdeaId: "",
                createdBy: idea.createdByActorID,
                createdAt: idea.createdAt,
                archived: idea.archived,
                sortOrder: idea.sortOrder
            )
            row.teamId = idea.teamID
            row.updatedAt = idea.updatedAt
            row.attachmentURLsJSON = encodeURLs(idea.attachmentURLs)
            modelContext.insert(row)
        }
    }

    /// The team's ideas as last fetched, for drawing the list before the
    /// network answers. Like and comment counts come back as zero — they are
    /// not cached (see `IdeaStore.applyLikeState`) and fill in on refresh.
    public static func cachedIdeas(teamID: String, modelContext: ModelContext) -> [IdeaRecord] {
        guard !teamID.isEmpty else { return [] }
        let descriptor = FetchDescriptor<SessionIdea>(
            predicate: #Predicate { $0.teamId == teamID }
        )
        let rows = (try? modelContext.fetch(descriptor)) ?? []
        return rows.map { row in
            IdeaRecord(
                id: row.ideaId,
                teamID: row.teamId,
                workspaceID: row.workspaceId,
                createdByActorID: row.createdBy,
                title: row.title,
                description: row.ideaDescription,
                status: row.status,
                archived: row.archived,
                sortOrder: row.sortOrder,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                attachmentURLs: decodeURLs(row.attachmentURLsJSON)
            )
        }
    }

    /// Drop the team's cached ideas the server no longer lists — deleted, or
    /// moved out of view — so the cache doesn't show them on the next launch.
    /// Only call with a complete list for the team (archived included).
    public static func prune(teamID: String, keeping ids: Set<String>, modelContext: ModelContext) {
        guard !teamID.isEmpty else { return }
        let descriptor = FetchDescriptor<SessionIdea>(
            predicate: #Predicate { $0.teamId == teamID }
        )
        let rows = (try? modelContext.fetch(descriptor)) ?? []
        var removed = false
        for row in rows where !ids.contains(row.ideaId) {
            modelContext.delete(row)
            removed = true
        }
        if removed { try? modelContext.save() }
    }

    private static func encodeURLs(_ urls: [URL]) -> String {
        guard !urls.isEmpty,
              let data = try? JSONEncoder().encode(urls),
              let json = String(data: data, encoding: .utf8)
        else { return "" }
        return json
    }

    private static func decodeURLs(_ json: String) -> [URL] {
        guard !json.isEmpty, let data = json.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([URL].self, from: data)) ?? []
    }
}
