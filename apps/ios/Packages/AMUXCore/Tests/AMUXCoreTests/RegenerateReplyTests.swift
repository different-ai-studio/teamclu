import XCTest
import SwiftData
@testable import AMUXCore

private actor PublishLog {
    private(set) var payloads: [Data] = []
    func append(_ data: Data) { payloads.append(data) }
}

/// Regenerate re-asks the prompt that started a turn, addressed to that
/// turn's agent, without disturbing the composer's agent selection.
@MainActor
final class RegenerateReplyTests: XCTestCase {

    private func makeViewModel(log: PublishLog) throws -> (SessionDetailViewModel, ModelContext, ModelContainer) {
        let mqtt = MQTTService(
            subscribeHook: { _ in }, unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in await log.append(payload) }
        )
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let service = TeamcluService()
        service.configureRuntimeForTesting(mqtt: mqtt, teamId: "team-1", peerId: "p", modelContainer: container)
        service.setLocalMemberIdForTesting("human-1")
        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        context.insert(session)
        let vm = SessionDetailViewModel(
            mqtt: mqtt, hub: MQTTMessageHub(mqtt: mqtt), teamID: "team-1", peerId: "p",
            session: session, teamcluService: service
        )
        vm._installPerfFixture(turns: 3, modelContext: context)
        return (vm, context, container)
    }

    private func lastTurn(_ vm: SessionDetailViewModel) throws -> (id: String, agentID: String) {
        for item in vm.feedItems.reversed() {
            if case .completedTurn(let id, let agentID, _, _) = item { return (id, agentID) }
        }
        throw XCTSkip("fixture has no completed turn")
    }

    func testFindsThePromptDirectlyAboveTheTurn() throws {
        let (vm, _, container) = try makeViewModel(log: PublishLog())
        let turn = try lastTurn(vm)
        let index = try XCTUnwrap(vm.feedItems.firstIndex { $0.id == turn.id })
        let expected = vm.feedItems[..<index].reversed().compactMap { item -> AgentEvent? in
            if case .userMessage(let e) = item { return e }
            return nil
        }.first
        XCTAssertNotNil(expected)
        XCTAssertTrue(vm.promptForRegeneration(turnItemID: turn.id) === expected)
        withExtendedLifetime(container) {}
    }

    func testAPromptWithFilesIsNotOfferedForRegeneration() throws {
        let (vm, _, container) = try makeViewModel(log: PublishLog())
        let turn = try lastTurn(vm)
        let prompt = try XCTUnwrap(vm.promptForRegeneration(turnItemID: turn.id))
        prompt.attachments = [MessageAttachment(filename: "b.png", mime: "image/png", size: 1, bucketPath: "a/b.png")]
        XCTAssertNil(vm.promptForRegeneration(turnItemID: turn.id))
        withExtendedLifetime(container) {}
    }

    func testRegenerateMentionsTheTurnsAgentAndLeavesTheChipsAlone() async throws {
        let log = PublishLog()
        let (vm, context, container) = try makeViewModel(log: log)
        let turn = try lastTurn(vm)
        let prompt = try XCTUnwrap(vm.promptForRegeneration(turnItemID: turn.id)?.text)
        vm.setAgentChipSelection([])

        try await vm.regenerate(turnItemID: turn.id, agentID: turn.agentID, modelContext: context)

        let payloads = await log.payloads
        let live = try Teamclu_LiveEventEnvelope(serializedBytes: try XCTUnwrap(payloads.last))
        let envelope = try Teamclu_SessionMessageEnvelope(serializedBytes: live.body)
        XCTAssertEqual(envelope.mentionActorIds, [turn.agentID])
        XCTAssertTrue(envelope.message.content.hasSuffix(prompt))
        XCTAssertTrue(vm.agentChipSelection.isEmpty)
        withExtendedLifetime(container) {}
    }
}
