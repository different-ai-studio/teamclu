import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class SessionListAdoptCreatedTests: XCTestCase {
    // Held for the test's lifetime: a context outliving its container traps.
    private var container: ModelContainer!

    private func makeContext() throws -> ModelContext {
        container = try ModelContainer(for: Schema(AMUXSchemaV1.models),
                                       configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        return container.mainContext
    }

    /// Mirrors `SessionCreationUseCase.persistLocalSession`.
    private func insertCreatedSession(_ ctx: ModelContext) throws {
        let session = Session(sessionId: "new", teamId: "t", title: "t", createdBy: "me", createdAt: .now,
                              summary: "", participantCount: 2, lastMessagePreview: "",
                              lastMessageAt: nil, ideaId: "")
        session.selectedAgentIds = ["agent-1"]
        ctx.insert(session)
        try ctx.save()
    }

    func test_adoptCreatedSession_keepsTheRowAndItsSelectedAgents() throws {
        let ctx = try makeContext()
        let list = SessionListViewModel()
        list.syncSessionRecords([], modelContext: ctx)   // last cloud sync predates the session
        try insertCreatedSession(ctx)

        list.adoptCreatedSession("new", modelContext: ctx)

        let rows = try ctx.fetch(FetchDescriptor<Session>())
        XCTAssertEqual(rows.map(\.sessionId), ["new"])
        XCTAssertEqual(rows.first?.selectedAgentIds, ["agent-1"])
    }

    /// The bug the method exists for: a plain reload after create deleted the
    /// row, and the re-sync recreated it without `selectedAgentIds`.
    func test_plainReload_dropsALocallyCreatedRow() throws {
        let ctx = try makeContext()
        let list = SessionListViewModel()
        list.syncSessionRecords([], modelContext: ctx)
        try insertCreatedSession(ctx)

        list.reloadSessions(modelContext: ctx)

        XCTAssertTrue(try ctx.fetch(FetchDescriptor<Session>()).isEmpty)
    }
}
