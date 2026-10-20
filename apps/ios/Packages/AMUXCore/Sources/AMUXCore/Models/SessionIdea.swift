import Foundation
import SwiftData

@Model
public final class SessionIdea {
    @Attribute(.unique) public var ideaId: String
    public var sessionId: String
    public var workspaceId: String
    public var title: String
    public var ideaDescription: String
    public var status: String           // "open", "in_progress", "done"
    public var parentIdeaId: String
    public var createdBy: String
    public var createdAt: Date
    public var archived: Bool
    public var sortOrder: Int
    /// The rest of what the Ideas list needs to draw a cached row before the
    /// network answers (see `IdeaCacheSynchronizer.cachedIdeas`). Defaulted
    /// so lightweight migration covers them; rows written before 1.20 carry
    /// an empty `teamId` and simply aren't read back until the next refresh
    /// rewrites them. Like and comment counts are deliberately absent — see
    /// `IdeaStore.applyLikeState`.
    public var teamId: String = ""
    public var updatedAt: Date = Date(timeIntervalSince1970: 0)
    public var attachmentURLsJSON: String = ""

    public init(
        ideaId: String,
        sessionId: String = "",
        workspaceId: String = "",
        title: String = "",
        ideaDescription: String = "",
        status: String = "open",
        parentIdeaId: String = "",
        createdBy: String = "",
        createdAt: Date = .now,
        archived: Bool = false,
        sortOrder: Int = 0
    ) {
        self.ideaId = ideaId
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.title = title
        self.ideaDescription = ideaDescription
        self.status = status
        self.parentIdeaId = parentIdeaId
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.archived = archived
        self.sortOrder = sortOrder
    }

    public var displayTitle: String {
        if !title.isEmpty { return title }
        let desc = ideaDescription
        if desc.count <= 50 { return desc }
        let prefix = desc.prefix(50)
        if let lastSpace = prefix.lastIndex(of: " ") {
            return String(prefix[prefix.startIndex..<lastSpace]) + "…"
        }
        return String(prefix) + "…"
    }

    public var isOpen: Bool { status == "open" }
    public var isInProgress: Bool { status == "in_progress" }
    public var isDone: Bool { status == "done" }
    public var statusLabel: String {
        switch status {
        case "open": return String(localized: "Open")
        case "in_progress": return String(localized: "In Progress")
        case "done": return String(localized: "Done")
        default: return status
        }
    }
}
