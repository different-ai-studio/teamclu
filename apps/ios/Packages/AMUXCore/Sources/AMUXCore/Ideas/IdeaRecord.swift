import Foundation

public struct IdeaRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public var workspaceID: String
    public let createdByActorID: String
    public var title: String
    public var description: String
    public var status: String
    public var archived: Bool
    public var sortOrder: Int
    public let createdAt: Date
    public var updatedAt: Date
    /// Pictures posted with the idea. Distinct from a comment's attachments,
    /// which belong to the activity that carried them.
    public var attachmentURLs: [URL]
    /// Feed counts. The list endpoint aggregates them; a single-idea read does
    /// not, so a record fetched on its own reports zeros — the feed row the
    /// caller navigated from is where these come from.
    public var commentCount: Int
    public var likeCount: Int
    public var likedByMe: Bool

    public init(
        id: String,
        teamID: String,
        workspaceID: String,
        createdByActorID: String,
        title: String,
        description: String,
        status: String,
        archived: Bool,
        sortOrder: Int = 0,
        createdAt: Date,
        updatedAt: Date,
        attachmentURLs: [URL] = [],
        commentCount: Int = 0,
        likeCount: Int = 0,
        likedByMe: Bool = false
    ) {
        self.id = id
        self.teamID = teamID
        self.workspaceID = workspaceID
        self.createdByActorID = createdByActorID
        self.title = title
        self.description = description
        self.status = status
        self.archived = archived
        self.sortOrder = sortOrder
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.attachmentURLs = attachmentURLs
        self.commentCount = commentCount
        self.likeCount = likeCount
        self.likedByMe = likedByMe
    }

    public var displayTitle: String {
        if !title.isEmpty {
            return title
        }

        if description.count <= 50 {
            return description
        }

        let prefix = description.prefix(50)
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
        case "open":
            return String(localized: "Open")
        case "in_progress":
            return String(localized: "In Progress")
        case "done":
            return String(localized: "Done")
        default:
            return status
        }
    }
}

public struct IdeaCreateInput: Equatable, Sendable {
    public let title: String
    public let description: String
    public let workspaceID: String
    /// Already-uploaded image URLs to post with the idea.
    public let attachmentURLs: [URL]

    public init(title: String, description: String, workspaceID: String,
                attachmentURLs: [URL] = []) {
        self.title = title
        self.description = description
        self.workspaceID = workspaceID
        self.attachmentURLs = attachmentURLs
    }
}

/// What a like toggle settles on, as the server reports it back.
public struct IdeaLikeState: Equatable, Sendable {
    public let likeCount: Int
    public let likedByMe: Bool

    public init(likeCount: Int, likedByMe: Bool) {
        self.likeCount = likeCount
        self.likedByMe = likedByMe
    }
}

public struct IdeaUpdateInput: Equatable, Sendable {
    public let title: String
    public let description: String
    public let status: String
    public let workspaceID: String

    public init(title: String, description: String, status: String, workspaceID: String) {
        self.title = title
        self.description = description
        self.status = status
        self.workspaceID = workspaceID
    }
}

public struct IdeaActivityCreateInput: Equatable, Sendable {
    public let activityType: String
    public let content: String
    public let metadata: [String: String]
    public let attachmentURLs: [URL]

    public init(
        activityType: String,
        content: String,
        metadata: [String: String] = [:],
        attachmentURLs: [URL] = []
    ) {
        self.activityType = activityType
        self.content = content
        self.metadata = metadata
        self.attachmentURLs = attachmentURLs
    }
}
