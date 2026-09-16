import Testing
import Foundation
import SwiftData
@testable import AMUXCore

// MARK: - Fakes

private actor FakeMessagesRepository: MessagesRepository {
    private(set) var patchedIDs: [String] = []
    private(set) var patchedContents: [String] = []
    private(set) var deletedIDs: [String] = []
    private var shouldFail = false

    func setShouldFail(_ value: Bool) { shouldFail = value }

    func listForSession(sessionID: String) async throws -> [MessageRecord] { [] }
    func insert(_ input: MessageInsertInput) async throws {}

    func patch(messageID: String, content: String) async throws {
        if shouldFail { throw CloudAPIError.invalidResponse }
        patchedIDs.append(messageID)
        patchedContents.append(content)
    }

    func delete(messageID: String) async throws {
        if shouldFail { throw CloudAPIError.invalidResponse }
        deletedIDs.append(messageID)
    }

    func submitFeedback(_ input: FeedbackInput) async throws {
        if shouldFail { throw CloudAPIError.invalidResponse }
    }

    func deleteFeedback(messageID: String, actorID: String) async throws {
        if shouldFail { throw CloudAPIError.invalidResponse }
    }

    func listFeedback(sessionID: String) async throws -> [FeedbackRecord] { [] }

    func turnTrace(teamID: String, sessionID: String, turnID: String) async throws -> TurnTraceLocation? { nil }
}

private actor FakeSessionsRepository: SessionsRepository {
    private(set) var unreadSessionIDs: [String] = []
    private var shouldFail = false

    func setShouldFail(_ value: Bool) { shouldFail = value }

    func listSessions(teamID: String) async throws -> [SessionRecord] { [] }
    func fetchUnreadFlags(teamID: String, limit: Int) async throws -> [String: Bool] { [:] }
    func markSessionViewed(sessionId: String, lastReadMessageId: String?) async throws {}

    func markSessionUnread(sessionId: String) async throws {
        if shouldFail { throw CloudAPIError.invalidResponse }
        unreadSessionIDs.append(sessionId)
    }

    func renameSession(sessionId: String, title: String) async throws {
        if shouldFail { throw CloudAPIError.invalidResponse }
    }

    func setSessionArchived(sessionId: String, archivedAt: Date?) async throws {
        if shouldFail { throw CloudAPIError.invalidResponse }
    }
}

// MARK: - Detail VM edit/delete

@Suite("SessionDetailViewModel — edit/delete own messages")
@MainActor
struct MessageEditDeleteTests {
    private struct Harness {
        let vm: SessionDetailViewModel
        let ctx: ModelContext
        // Retained so SwiftData rows survive until assertions run.
        let container: ModelContainer
        let repo: FakeMessagesRepository
    }

    /// VM bound to a session with one persisted own user prompt
    /// (supabaseMessageId = "msg-1") plus its SessionMessage mirror,
    /// loaded through `_test_start` so reducer state matches SwiftData.
    private func makeHarness() throws -> Harness {
        let container = try ModelContainer(
            for: AgentEvent.self, Session.self, SessionMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        let session = Session(sessionId: "session-1", teamId: "team-1")
        ctx.insert(session)

        let event = AgentEvent(agentId: "session-1", sequence: 1, eventType: "user_prompt")
        event.text = "original"
        event.senderActorID = "me"
        event.supabaseMessageId = "msg-1"
        ctx.insert(event)

        let cached = SessionMessage(
            messageId: "msg-1",
            sessionId: "session-1",
            senderActorId: "me",
            content: "original"
        )
        ctx.insert(cached)
        try ctx.save()

        let repo = FakeMessagesRepository()
        let mqtt = MQTTService()
        let vm = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer",
            session: session,
            messagesRepository: repo
        )
        vm._test_start(modelContext: ctx)
        return Harness(vm: vm, ctx: ctx, container: container, repo: repo)
    }

    @Test("edit patches remote then rewrites the local event + cache row")
    func editUpdatesEventAndCache() async throws {
        let h = try makeHarness()
        #expect(h.vm.events.first?.text == "original")

        await h.vm.editUserMessage(supabaseMessageID: "msg-1", newContent: "  edited  ")

        #expect(await h.repo.patchedIDs == ["msg-1"])
        #expect(await h.repo.patchedContents == ["edited"], "content must be trimmed before PATCH")
        #expect(h.vm.events.first?.text == "edited")

        let cached = try h.ctx.fetch(
            FetchDescriptor<SessionMessage>(predicate: #Predicate { $0.messageId == "msg-1" })
        )
        #expect(cached.first?.content == "edited")
    }

    @Test("delete removes the event, the SwiftData row, and the cache row")
    func deleteRemovesEventAndCache() async throws {
        let h = try makeHarness()

        await h.vm.deleteUserMessage(supabaseMessageID: "msg-1")

        #expect(await h.repo.deletedIDs == ["msg-1"])
        #expect(h.vm.events.isEmpty)
        #expect(h.vm.feedItems.isEmpty)

        let rows = try h.ctx.fetch(FetchDescriptor<AgentEvent>())
        #expect(rows.isEmpty, "AgentEvent row must be deleted from SwiftData")
        let cached = try h.ctx.fetch(FetchDescriptor<SessionMessage>())
        #expect(cached.isEmpty, "SessionMessage mirror must be deleted")
    }

    @Test("remote failure leaves local state untouched and surfaces the error")
    func remoteFailureKeepsLocalState() async throws {
        let h = try makeHarness()
        await h.repo.setShouldFail(true)

        await h.vm.editUserMessage(supabaseMessageID: "msg-1", newContent: "edited")
        #expect(h.vm.events.first?.text == "original")
        #expect(h.vm.sendErrorMessage != nil)

        await h.vm.deleteUserMessage(supabaseMessageID: "msg-1")
        #expect(h.vm.events.count == 1)
    }

    @Test("blank edit is a no-op (never PATCHes an empty body)")
    func blankEditIsNoOp() async throws {
        let h = try makeHarness()

        await h.vm.editUserMessage(supabaseMessageID: "msg-1", newContent: "   \n ")

        #expect(await h.repo.patchedIDs.isEmpty)
        #expect(h.vm.events.first?.text == "original")
    }
}

// MARK: - List VM mark-unread

@Suite("SessionListViewModel — mark session unread")
@MainActor
struct MarkSessionUnreadTests {
    private struct Harness {
        let vm: SessionListViewModel
        let ctx: ModelContext
        let container: ModelContainer
        let session: Session
        let repo: FakeSessionsRepository
    }

    private func makeHarness() throws -> Harness {
        let container = try ModelContainer(
            for: Session.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let ctx = ModelContext(container)
        let session = Session(sessionId: "session-1", teamId: "team-1", hasUnread: false)
        ctx.insert(session)
        try ctx.save()
        return Harness(
            vm: SessionListViewModel(),
            ctx: ctx,
            container: container,
            session: session,
            repo: FakeSessionsRepository()
        )
    }

    @Test("flips hasUnread optimistically and posts to the server")
    func marksUnreadAndCallsServer() async throws {
        let h = try makeHarness()

        await h.vm.markSessionUnread(
            sessionId: "session-1",
            sessionsRepo: h.repo,
            modelContext: h.ctx
        )

        #expect(h.session.hasUnread == true)
        #expect(await h.repo.unreadSessionIDs == ["session-1"])
    }

    @Test("rolls the optimistic flag back when the server rejects")
    func rollsBackOnServerFailure() async throws {
        let h = try makeHarness()
        await h.repo.setShouldFail(true)

        await h.vm.markSessionUnread(
            sessionId: "session-1",
            sessionsRepo: h.repo,
            modelContext: h.ctx
        )

        #expect(h.session.hasUnread == false)
    }

    @Test("already-unread session is a no-op")
    func alreadyUnreadIsNoOp() async throws {
        let h = try makeHarness()
        h.session.hasUnread = true
        try h.ctx.save()

        await h.vm.markSessionUnread(
            sessionId: "session-1",
            sessionsRepo: h.repo,
            modelContext: h.ctx
        )

        #expect(await h.repo.unreadSessionIDs.isEmpty)
        #expect(h.session.hasUnread == true)
    }
}
