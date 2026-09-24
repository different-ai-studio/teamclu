import XCTest
import SwiftData
@testable import AMUXCore

/// The session list's third line names a session's app or idea from values
/// cached on the `Session` row. These pin how that cache is written: kept
/// across refreshes, dropped when the link it describes changes.
@MainActor
final class SessionContextNameTests: XCTestCase {
    private var container: ModelContainer!

    private func makeContext() throws -> ModelContext {
        container = try ModelContainer(
            for: Schema(AMUXSchemaV1.models),
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        return container.mainContext
    }

    private func record(id: String, ideaID: String? = nil, appID: String? = nil) -> SessionRecord {
        SessionRecord(
            id: id, teamID: "t-1", ideaID: ideaID, createdByActorID: "", primaryAgentID: nil,
            mode: "solo", title: id, summary: "", participantCount: 1, lastMessagePreview: "",
            lastMessageAt: nil, createdAt: .now, source: "user", appID: appID
        )
    }

    private func session(_ id: String, in context: ModelContext) throws -> Session {
        let rows = try context.fetch(FetchDescriptor<Session>(predicate: #Predicate { $0.sessionId == id }))
        return try XCTUnwrap(rows.first)
    }

    func testAppNameSurvivesRefreshAndClearsWhenAppChanges() throws {
        let context = try makeContext()
        let viewModel = SessionListViewModel()

        viewModel.syncSessionRecords([record(id: "s-1", appID: "a-1")], modelContext: context)
        viewModel.applyAppNames(["a-1": "Expense Bot"], modelContext: context)
        XCTAssertEqual(try session("s-1", in: context).appName, "Expense Bot")

        // A refresh that doesn't carry names keeps the cached one.
        viewModel.syncSessionRecords([record(id: "s-1", appID: "a-1")], modelContext: context)
        XCTAssertEqual(try session("s-1", in: context).appName, "Expense Bot")

        // An app missing from the apps list keeps its last known name.
        viewModel.applyAppNames([:], modelContext: context)
        XCTAssertEqual(try session("s-1", in: context).appName, "Expense Bot")

        // Relinked to another app: the old name must not linger.
        viewModel.syncSessionRecords([record(id: "s-1", appID: "a-2")], modelContext: context)
        XCTAssertEqual(try session("s-1", in: context).appId, "a-2")
        XCTAssertEqual(try session("s-1", in: context).appName, "")
    }

    func testIdeaTitleComesFromIdeaCache() throws {
        let context = try makeContext()
        let viewModel = SessionListViewModel()
        context.insert(SessionIdea(ideaId: "i-1", title: "Weekly digest"))
        try context.save()

        viewModel.syncSessionRecords(
            [record(id: "s-1", ideaID: "i-1"), record(id: "s-2", ideaID: "i-9")],
            modelContext: context
        )

        XCTAssertEqual(try session("s-1", in: context).ideaTitle, "Weekly digest")
        XCTAssertEqual(viewModel.ideaIDsMissingTitle(modelContext: context), ["i-9"])

        // Detached from its idea: the title goes with it.
        viewModel.syncSessionRecords([record(id: "s-1")], modelContext: context)
        XCTAssertEqual(try session("s-1", in: context).ideaTitle, "")
    }
}
