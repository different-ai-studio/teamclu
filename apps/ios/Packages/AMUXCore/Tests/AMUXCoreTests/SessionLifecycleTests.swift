import XCTest
import SwiftData
@testable import AMUXCore

/// Rename / archive ride `PATCH /v1/sessions/:id` with an optimistic local
/// flip. These tests pin the two properties that matter: the server call
/// carries the right payload, and a rejected call reverts the local row
/// instead of leaving the list lying about server state.
@MainActor
final class SessionLifecycleTests: XCTestCase {
    private actor RecordingSessionsRepository: SessionsRepository {
        private(set) var renames: [(String, String)] = []
        private(set) var archives: [(String, Date?)] = []
        private var shouldFail = false

        func setShouldFail(_ value: Bool) { shouldFail = value }

        func listSessions(teamID: String) async throws -> [SessionRecord] { [] }
        func markSessionViewed(sessionId: String, lastReadMessageId: String?) async throws {}
        func markSessionUnread(sessionId: String) async throws {}

        func renameSession(sessionId: String, title: String) async throws {
            if shouldFail { throw CloudAPIError.invalidResponse }
            renames.append((sessionId, title))
        }

        func setSessionArchived(sessionId: String, archivedAt: Date?) async throws {
            if shouldFail { throw CloudAPIError.invalidResponse }
            archives.append((sessionId, archivedAt))
        }
    }

    /// Held on the instance: `mainContext` is only valid while its
    /// container lives, and a test that destructured the container into
    /// `_` was deallocating it mid-test (SwiftData traps on first use).
    private var container: ModelContainer!

    private func makeContext() throws -> ModelContext {
        container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        return container.mainContext
    }

    func testRenamePatchesServerAndLocalRow() async throws {
        let context = try makeContext()
        let session = Session(sessionId: "s-1", teamId: "t-1")
        session.title = "Old"
        context.insert(session)
        try context.save()

        let repo = RecordingSessionsRepository()
        let viewModel = SessionListViewModel()
        await viewModel.renameSession(
            sessionId: "s-1",
            newTitle: "  New Name  ",
            sessionsRepo: repo,
            modelContext: context
        )

        XCTAssertEqual(session.title, "New Name")
        let renames = await repo.renames
        XCTAssertEqual(renames.count, 1)
        XCTAssertEqual(renames.first?.0, "s-1")
        XCTAssertEqual(renames.first?.1, "New Name")
    }

    func testRenameRevertsWhenServerRejects() async throws {
        let context = try makeContext()
        let session = Session(sessionId: "s-1", teamId: "t-1")
        session.title = "Old"
        context.insert(session)
        try context.save()

        let repo = RecordingSessionsRepository()
        await repo.setShouldFail(true)
        let viewModel = SessionListViewModel()
        await viewModel.renameSession(
            sessionId: "s-1",
            newTitle: "New",
            sessionsRepo: repo,
            modelContext: context
        )

        XCTAssertEqual(session.title, "Old")
    }

    func testRenameIgnoresEmptyTitle() async throws {
        let context = try makeContext()
        let session = Session(sessionId: "s-1", teamId: "t-1")
        session.title = "Old"
        context.insert(session)
        try context.save()

        let repo = RecordingSessionsRepository()
        let viewModel = SessionListViewModel()
        await viewModel.renameSession(
            sessionId: "s-1",
            newTitle: "   ",
            sessionsRepo: repo,
            modelContext: context
        )

        XCTAssertEqual(session.title, "Old")
        let renames = await repo.renames
        XCTAssertTrue(renames.isEmpty)
    }

    func testArchiveStampsServerAndHidesRow() async throws {
        let context = try makeContext()
        let session = Session(sessionId: "s-1", teamId: "t-1")
        context.insert(session)
        try context.save()

        let repo = RecordingSessionsRepository()
        let viewModel = SessionListViewModel()
        await viewModel.archiveSession(
            sessionId: "s-1",
            sessionsRepo: repo,
            modelContext: context
        )

        XCTAssertTrue(session.isArchived)
        let archives = await repo.archives
        XCTAssertEqual(archives.count, 1)
        XCTAssertEqual(archives.first?.0, "s-1")
        XCTAssertNotNil(archives.first?.1, "archive must stamp archived_at, not clear it")
    }

    func testCronSessionsHiddenByDefaultAndClockViewShowsOnlyThem() async throws {
        let context = try makeContext()
        let normal = Session(sessionId: "s-1", teamId: "t-1")
        normal.title = "Chat"
        normal.lastMessageAt = .now
        let cron = Session(sessionId: "s-2", teamId: "t-1")
        cron.title = "Cron: test"
        cron.source = "cron"
        cron.lastMessageAt = .now
        context.insert(normal)
        context.insert(cron)
        try context.save()

        let viewModel = SessionListViewModel()
        viewModel.reloadSessions(modelContext: context)

        var ids = viewModel.groupedSessions.flatMap(\.items).map(\.sessionId)
        XCTAssertEqual(ids, ["s-1"], "cron-created sessions must not flood the default list")

        viewModel.showCronSessions = true
        ids = viewModel.groupedSessions.flatMap(\.items).map(\.sessionId)
        XCTAssertEqual(ids, ["s-2"], "clock view shows only scheduled sessions")
    }

    func testArchiveRevertsWhenServerRejects() async throws {
        let context = try makeContext()
        let session = Session(sessionId: "s-1", teamId: "t-1")
        context.insert(session)
        try context.save()

        let repo = RecordingSessionsRepository()
        await repo.setShouldFail(true)
        let viewModel = SessionListViewModel()
        await viewModel.archiveSession(
            sessionId: "s-1",
            sessionsRepo: repo,
            modelContext: context
        )

        XCTAssertFalse(session.isArchived)
    }
}
