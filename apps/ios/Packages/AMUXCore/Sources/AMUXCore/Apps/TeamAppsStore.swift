import Foundation
import Observation

/// The team's apps, for the list and the promo that stands in for it.
///
/// No SwiftData cache, unlike `ShortcutsStore`: the drawer shows shortcuts on
/// every open, while apps are a page the user navigates to and can wait a
/// moment for. An offline mirror would also have to model deploy state going
/// stale, which is exactly the field a cached row would be wrong about.
@Observable
@MainActor
public final class TeamAppsStore {
    public private(set) var apps: [TeamAppRecord] = []
    public private(set) var isLoading = false
    /// True once a load has finished, however it went. The empty state must
    /// not flash the "create your first app" promo before the first answer.
    public private(set) var hasLoaded = false
    public var errorMessage: String?

    private let teamID: String
    private let repository: any TeamAppRepository

    public init(teamID: String, repository: any TeamAppRepository) {
        self.teamID = teamID
        self.repository = repository
    }

    /// Apps the caller reaches by the given relationship, newest first (the
    /// order the server already returns).
    public func apps(matching filter: TeamAppRelationship?) -> [TeamAppRecord] {
        guard let filter else { return apps }
        return apps.filter { $0.relationship == filter }
    }

    public var isEmpty: Bool { apps.isEmpty }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            apps = try await repository.listApps(teamID: teamID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Creates the app and puts it at the head of the list, where the server
    /// would also place it. Throws so the sheet can stay open on failure.
    @discardableResult
    public func create(_ input: TeamAppCreateInput) async throws -> TeamAppRecord {
        let created = try await repository.createApp(teamID: teamID, input: input)
        apps.removeAll { $0.id == created.id }
        apps.insert(created, at: 0)
        errorMessage = nil
        return created
    }

    /// The sessions linked to an app. Not cached on the store: the detail view
    /// is the only reader, and it asks once per visit.
    public func sessions(forApp appID: String) async throws -> [TeamAppSessionRecord] {
        try await repository.listAppSessions(appID: appID)
    }

    /// Re-reads one app, for a detail view that wants the freshest deploy
    /// state without pulling the whole list. Silently leaves the row alone if
    /// it cannot be read — the detail view already shows what it opened with.
    public func refresh(appID: String) async -> TeamAppRecord? {
        guard let fresh = try? await repository.getApp(appID: appID) else { return nil }
        if let idx = apps.firstIndex(where: { $0.id == appID }) {
            apps[idx] = fresh
        }
        return fresh
    }
}
