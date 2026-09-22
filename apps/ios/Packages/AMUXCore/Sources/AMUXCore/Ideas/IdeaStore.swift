import Foundation
import Observation
import SwiftData
// `Array.move(fromOffsets:toOffset:)` below is a SwiftUI extension. This file
// used to get it for free because one other file in the module imported
// SwiftUI; deleting that file (an unused view) broke reordering here, which is
// why the import now lives where the dependency actually is.
import SwiftUI

@Observable
@MainActor
public final class IdeaStore {
    public private(set) var ideas: [IdeaRecord] = []
    public private(set) var archivedIdeas: [IdeaRecord] = []
    public private(set) var activitiesByIdeaID: [String: [IdeaActivityRecord]] = [:]
    public private(set) var isLoading = false
    public private(set) var isLoadingActivities = false
    public var errorMessage: String?

    private let teamID: String
    private let repository: any IdeaRepository
    private let modelContext: ModelContext

    public init(teamID: String, repository: any IdeaRepository, modelContext: ModelContext) {
        self.teamID = teamID
        self.repository = repository
        self.modelContext = modelContext
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            let remoteIdeas = try await repository.listIdeas(teamID: teamID)
            apply(remoteIdeas)
            IdeaCacheSynchronizer.upsert(remoteIdeas, modelContext: modelContext)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func createIdea(title: String, description: String, workspaceID: String,
                           attachmentURLs: [URL] = []) async -> Bool {
        do {
            let created = try await repository.createIdea(
                teamID: teamID,
                input: IdeaCreateInput(
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                    workspaceID: workspaceID,
                    attachmentURLs: attachmentURLs
                )
            )
            merge(created)
            IdeaCacheSynchronizer.upsert(created, modelContext: modelContext)
            try? modelContext.save()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Likes or unlikes, optimistically. The count moves under the thumb and
    /// is corrected by whatever the server reports; a failure puts the old
    /// values back rather than leaving a like that isn't there.
    ///
    /// Not a toggle over the wire: this sends the state it wants, so a slow
    /// network and an impatient second tap can't cancel each other out.
    public func setLiked(ideaID: String, liked: Bool) async {
        guard let before = idea(withID: ideaID) else { return }
        applyLikeState(
            ideaID: ideaID,
            state: IdeaLikeState(
                likeCount: max(0, before.likeCount + (liked ? 1 : -1)),
                likedByMe: liked
            )
        )
        do {
            let confirmed = try await repository.setIdeaLike(ideaID: ideaID, liked: liked)
            applyLikeState(ideaID: ideaID, state: confirmed)
            errorMessage = nil
        } catch {
            applyLikeState(
                ideaID: ideaID,
                state: IdeaLikeState(likeCount: before.likeCount, likedByMe: before.likedByMe)
            )
            errorMessage = error.localizedDescription
        }
    }

    private func idea(withID ideaID: String) -> IdeaRecord? {
        ideas.first { $0.id == ideaID } ?? archivedIdeas.first { $0.id == ideaID }
    }

    private func applyLikeState(ideaID: String, state: IdeaLikeState) {
        // The like count is not part of the SwiftData cache: it is a number
        // about other people that goes stale the moment it is written, and a
        // stale count shown offline is worse than no count. It lives only as
        // long as the loaded page.
        if let index = ideas.firstIndex(where: { $0.id == ideaID }) {
            ideas[index].likeCount = state.likeCount
            ideas[index].likedByMe = state.likedByMe
        }
        if let index = archivedIdeas.firstIndex(where: { $0.id == ideaID }) {
            archivedIdeas[index].likeCount = state.likeCount
            archivedIdeas[index].likedByMe = state.likedByMe
        }
    }

    @discardableResult
    public func updateIdea(
        ideaID: String,
        title: String,
        description: String,
        status: String,
        workspaceID: String
    ) async -> Bool {
        do {
            let updated = try await repository.updateIdea(
                ideaID: ideaID,
                input: IdeaUpdateInput(
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                    status: status,
                    workspaceID: workspaceID
                )
            )
            merge(updated)
            IdeaCacheSynchronizer.upsert(updated, modelContext: modelContext)
            try? modelContext.save()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    public func setArchived(ideaID: String, archived: Bool) async -> Bool {
        do {
            let updated = try await repository.setArchived(ideaID: ideaID, archived: archived)
            merge(updated)
            IdeaCacheSynchronizer.upsert(updated, modelContext: modelContext)
            try? modelContext.save()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func idea(id: String) -> IdeaRecord? {
        (ideas + archivedIdeas).first(where: { $0.id == id })
    }

    public func activities(for ideaID: String) -> [IdeaActivityRecord] {
        activitiesByIdeaID[ideaID] ?? []
    }

    public func reloadActivities(ideaID: String) async {
        guard !isLoadingActivities else { return }
        isLoadingActivities = true
        defer { isLoadingActivities = false }

        do {
            let activities = try await repository.listIdeaActivities(ideaID: ideaID)
            activitiesByIdeaID[ideaID] = activities
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func createActivity(
        ideaID: String,
        activityType: String,
        content: String,
        metadata: [String: String] = [:],
        attachmentURLs: [URL] = []
    ) async -> Bool {
        do {
            let activity = try await repository.createIdeaActivity(
                ideaID: ideaID,
                input: IdeaActivityCreateInput(
                    activityType: activityType,
                    content: content.trimmingCharacters(in: .whitespacesAndNewlines),
                    metadata: metadata,
                    attachmentURLs: attachmentURLs
                )
            )
            var activities = activitiesByIdeaID[ideaID] ?? []
            activities.removeAll { $0.id == activity.id }
            activities.insert(activity, at: 0)
            activitiesByIdeaID[ideaID] = activities
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    public func moveIdeas(from source: IndexSet, to destination: Int) {
        let movedRecords = source.compactMap { index in
            ideas.indices.contains(index) ? ideas[index] : nil
        }
        var reordered = ideas
        reordered.move(fromOffsets: source, toOffset: destination)

        for index in reordered.indices {
            reordered[index].sortOrder = (index + 1) * 1_000
        }
        ideas = reordered
        IdeaCacheSynchronizer.upsert(reordered, modelContext: modelContext)
        try? modelContext.save()

        let orderedIDs = reordered.map(\.id)
        Task {
            do {
                try await repository.reorderIdeas(teamID: teamID, ideaIDs: orderedIDs)
                for record in movedRecords {
                    if let newIndex = orderedIDs.firstIndex(of: record.id) {
                        await createActivity(
                            ideaID: record.id,
                            activityType: "reorder",
                            content: "Moved to position \(newIndex + 1)",
                            metadata: [
                                "position": "\(newIndex + 1)",
                                "total": "\(orderedIDs.count)",
                            ]
                        )
                    }
                }
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
                await reload()
            }
        }
    }

    private func apply(_ records: [IdeaRecord]) {
        let sorted = sort(records)
        ideas = sorted.filter { !$0.archived }
        archivedIdeas = sorted.filter(\.archived)
    }

    private func merge(_ record: IdeaRecord) {
        let previous = idea(id: record.id)
        var all = Dictionary(uniqueKeysWithValues: (ideas + archivedIdeas).map { ($0.id, $0) })
        all[record.id] = record
        apply(Array(all.values))

        if let previous, previous.status != record.status {
            Task {
                await createActivity(
                    ideaID: record.id,
                    activityType: "status_change",
                    content: "Changed status from \(previous.statusLabel) to \(record.statusLabel)",
                    metadata: [
                        "from_status": previous.status,
                        "to_status": record.status,
                    ]
                )
            }
        }
    }

    private func sort(_ records: [IdeaRecord]) -> [IdeaRecord] {
        records.sorted { lhs, rhs in
            if lhs.sortOrder != rhs.sortOrder {
                return lhs.sortOrder < rhs.sortOrder
            }
            if lhs.updatedAt == rhs.updatedAt {
                return lhs.createdAt > rhs.createdAt
            }
            return lhs.updatedAt > rhs.updatedAt
        }
    }
}
