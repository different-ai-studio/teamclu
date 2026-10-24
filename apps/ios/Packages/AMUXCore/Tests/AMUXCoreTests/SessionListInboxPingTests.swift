import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class SessionListInboxPingTests: XCTestCase {
    private var container: ModelContainer!

    private func makeContext() throws -> ModelContext {
        container = try ModelContainer(for: Schema(AMUXSchemaV1.models),
                                       configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        return container.mainContext
    }

    private func installActivityStore(_ list: SessionListViewModel, _ ctx: ModelContext) -> SessionLiveActivityStore {
        let activity = SessionLiveActivityStore()
        // An empty user id assigns the store and returns before any MQTT subscribe.
        let mqtt = MQTTService()
        list.startInboxSubscription(
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            userID: "",
            teamID: "t",
            sessionsRepo: nil,
            modelContext: ctx,
            liveActivityStore: activity
        )
        return activity
    }

    func test_rosterPingDoesNotMarkUnreadOrNoteActivity() async throws {
        let ctx = try makeContext()
        let session = Session(sessionId: "s1", teamId: "t", title: "Chat", createdBy: "me", createdAt: .now,
                              summary: "", participantCount: 1, lastMessagePreview: "",
                              lastMessageAt: nil, ideaId: "", hasUnread: false)
        ctx.insert(session)
        try ctx.save()

        let list = SessionListViewModel()
        let activity = installActivityStore(list, ctx)
        await list.applyInboxPing(
            InboxPing(sessionID: "s1", type: "session.participants", ts: 1),
            teamID: "t",
            sessionsRepo: nil,
            modelContext: ctx
        )

        let rows = try ctx.fetch(FetchDescriptor<Session>())
        XCTAssertEqual(rows.first?.hasUnread, false)
        XCTAssertEqual(activity.notedSessionIDs, [])
    }

    func test_messagePingStillMarksUnreadAndNotesActivity() async throws {
        let ctx = try makeContext()
        let session = Session(sessionId: "s1", teamId: "t", title: "Chat", createdBy: "me", createdAt: .now,
                              summary: "", participantCount: 1, lastMessagePreview: "",
                              lastMessageAt: nil, ideaId: "", hasUnread: false)
        ctx.insert(session)
        try ctx.save()

        let list = SessionListViewModel()
        let activity = installActivityStore(list, ctx)
        await list.applyInboxPing(
            InboxPing(sessionID: "s1", type: "message", ts: 1),
            teamID: "t",
            sessionsRepo: nil,
            modelContext: ctx
        )

        let rows = try ctx.fetch(FetchDescriptor<Session>())
        XCTAssertEqual(rows.first?.hasUnread, true)
        XCTAssertEqual(activity.notedSessionIDs, ["s1"])
    }
}
