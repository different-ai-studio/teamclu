import Foundation

/// A team app as the Cloud API reports it (`GET /v1/apps`).
///
/// Named `TeamApp…` rather than `App…` because this package already uses
/// "app" for the AMUX client itself — `AppOnboardingCoordinator`, `AppTab`.
/// The domain word the product uses is 团队应用, and the distinction matters
/// most in the view layer, where `App` is also SwiftUI's own.
///
/// Only the fields iOS renders are carried. The server's `App` schema is much
/// wider (auth rules, custom domains, cron, env); those belong to surfaces
/// this client does not have.
public struct TeamAppRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public let createdByActorID: String?
    public var name: String
    public let slug: String
    public var type: TeamAppType
    public var visibility: TeamAppVisibility
    public var provisionStatus: TeamAppProvisionStatus
    /// `nil` means never deployed — distinct from `.notDeployed`, which the
    /// server sets once a deploy has been attempted and undone.
    public var fcStatus: TeamAppFcStatus?
    /// Derived server-side from the slug and id; absent until the app is live.
    public var publicURL: URL?
    public var fcEndpoint: URL?
    public var gitRemoteURL: String?
    public var gitAuthKind: String?
    /// How the caller comes to see this app: they created it, they were
    /// granted access, or it is visible to the whole team.
    public var relationship: TeamAppRelationship
    public let createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        teamID: String,
        createdByActorID: String? = nil,
        name: String,
        slug: String,
        type: TeamAppType,
        visibility: TeamAppVisibility,
        provisionStatus: TeamAppProvisionStatus,
        fcStatus: TeamAppFcStatus? = nil,
        publicURL: URL? = nil,
        fcEndpoint: URL? = nil,
        gitRemoteURL: String? = nil,
        gitAuthKind: String? = nil,
        relationship: TeamAppRelationship = .team,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.teamID = teamID
        self.createdByActorID = createdByActorID
        self.name = name
        self.slug = slug
        self.type = type
        self.visibility = visibility
        self.provisionStatus = provisionStatus
        self.fcStatus = fcStatus
        self.publicURL = publicURL
        self.fcEndpoint = fcEndpoint
        self.gitRemoteURL = gitRemoteURL
        self.gitAuthKind = gitAuthKind
        self.relationship = relationship
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// The address to open, preferring the derived public URL over the raw
    /// function endpoint the way the desktop library does.
    public var openableURL: URL? { publicURL ?? fcEndpoint }

    /// An app whose code has not been written yet.
    ///
    /// Creating one from this client only inserts the row: writing the starter
    /// template (or cloning an import) is the local daemon's job, and iOS has
    /// no daemon. Such an app sits at `repo_created` until someone opens it on
    /// a desktop, and the server refuses to deploy it before then —
    /// `provision_status != 'ready'` answers 409 `app_not_ready`.
    public var needsDesktopSetup: Bool {
        provisionStatus != .ready && provisionStatus != .error
    }

    /// One line of status, mirroring the desktop library's precedence: the
    /// deploy lifecycle wins over provisioning, because once an app has been
    /// deployed its live state is what the reader is asking about.
    /// See `packages/app/src/lib/apps/app-list-helpers.ts`.
    public var statusLabel: String {
        switch fcStatus {
        case .live where openableURL != nil:
            return "已上线"
        case .deployError:
            return "部署失败"
        case .awaitingBuild, .building, .deploying:
            return "部署中…"
        case .live, .notDeployed, .none:
            break
        }
        switch provisionStatus {
        case .ready:
            return "待部署"
        case .error:
            return "初始化失败"
        case .pending, .repoCreated, .seeding:
            return "待初始化"
        }
    }

    public var statusKind: TeamAppStatusKind {
        switch fcStatus {
        case .live where openableURL != nil:
            return .live
        case .deployError:
            return .failed
        case .awaitingBuild, .building, .deploying:
            return .working
        case .live, .notDeployed, .none:
            break
        }
        switch provisionStatus {
        case .ready:      return .idle
        case .error:      return .failed
        case .pending, .repoCreated, .seeding: return .pending
        }
    }

    /// Where the code lives, in the reader's terms rather than the column's.
    public var sourceLabel: String {
        if gitAuthKind == "gitea_deploy_key" { return "托管仓库" }
        if let url = gitRemoteURL, !url.trimmingCharacters(in: .whitespaces).isEmpty { return "外部仓库" }
        return "仅本机"
    }
}

/// The colour a status dot takes. Mapped to palette tokens in the view layer
/// so this package stays free of SwiftUI.
public enum TeamAppStatusKind: String, Codable, Sendable {
    case live
    case working
    case failed
    case pending
    case idle
}

public enum TeamAppType: String, Codable, Sendable, CaseIterable {
    case staticWeb = "static_web"
    case slides
    case dataApp = "data_app"
    case imported
    /// Legacy, read-only: the server rejects it on write. Kept so an older row
    /// still decodes instead of falling back to a wrong type.
    case fullstackTanstackPostgres = "fullstack_tanstack_postgres"

    /// The types this client offers when creating. `imported` needs a git
    /// address and a daemon to clone with; the legacy one cannot be written.
    public static var creatable: [TeamAppType] { [.staticWeb, .slides, .dataApp] }

    public var label: String {
        switch self {
        case .staticWeb: return "静态网页"
        case .slides: return "幻灯片"
        case .dataApp: return "数据应用"
        case .imported: return "导入的仓库"
        case .fullstackTanstackPostgres: return "全栈应用"
        }
    }

    /// SF Symbol name. Kept here so the list and the detail agree without the
    /// view layer restating the mapping.
    public var symbolName: String {
        switch self {
        case .staticWeb: return "globe"
        case .slides: return "rectangle.on.rectangle"
        case .dataApp: return "chart.bar.doc.horizontal"
        case .imported: return "arrow.down.doc"
        case .fullstackTanstackPostgres: return "square.stack.3d.up"
        }
    }
}

public enum TeamAppVisibility: String, Codable, Sendable, CaseIterable {
    case personal
    case team

    public var label: String {
        switch self {
        case .personal: return "仅自己和受邀的人"
        case .team: return "整个团队"
        }
    }
}

public enum TeamAppProvisionStatus: String, Codable, Sendable {
    case pending
    case repoCreated = "repo_created"
    case seeding
    case ready
    case error
}

public enum TeamAppFcStatus: String, Codable, Sendable {
    case notDeployed = "not_deployed"
    case awaitingBuild = "awaiting_build"
    case building
    case deploying
    case live
    case deployError = "deploy_error"
}

public enum TeamAppRelationship: String, Codable, Sendable, CaseIterable {
    case owner
    case invited
    case team

    public var label: String {
        switch self {
        case .owner: return "我创建的"
        case .invited: return "邀请我的"
        case .team: return "团队的"
        }
    }
}

/// A session linked to an app (`GET /v1/apps/{appId}/sessions`). A thin row —
/// tapping it hands the id to the sessions stack, which owns the real model.
public struct TeamAppSessionRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public let title: String
    public let mode: String
    public let lastMessageAt: Date?
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: String,
        teamID: String,
        title: String,
        mode: String,
        lastMessageAt: Date? = nil,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.teamID = teamID
        self.title = title
        self.mode = mode
        self.lastMessageAt = lastMessageAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
