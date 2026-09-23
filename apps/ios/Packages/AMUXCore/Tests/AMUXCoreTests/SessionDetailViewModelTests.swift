import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class SessionDetailViewModelTests: XCTestCase {
    private actor PublishedMessages {
        private(set) var value: [(String, Data, Bool)] = []

        func append(_ message: (String, Data, Bool)) {
            value.append(message)
        }
    }

    /// Polls `published` until a message lands on `topic` (or fails after
    /// ~1s). Commands ride the RPC channel now, so the interesting publish
    /// is the `rpc/req` payload — other topics may interleave.
    private func awaitPublish(
        _ published: PublishedMessages,
        onTopic topic: String,
        maxAttempts: Int = 100
    ) async throws -> Data {
        var attempts = 0
        while attempts < maxAttempts {
            if let match = await published.value.first(where: { $0.0 == topic }) {
                XCTAssertFalse(match.2, "RPC requests must not be retained")
                return match.1
            }
            try await Task.sleep(for: .milliseconds(10))
            attempts += 1
        }
        XCTFail("no publish observed on \(topic)")
        throw CancellationError()
    }

    /// Decodes the runtime_command RPC captured on the target actor's
    /// `rpc/req` topic and replies `dispatched: true` on the requester's
    /// `rpc/res` topic so the in-flight command call can return.
    private func replyDispatched(
        _ mqtt: MQTTService,
        rpcRequest: Teamclu_RpcRequest,
        requesterActorID: String
    ) throws {
        var result = Teamclu_RuntimeCommandResult()
        result.dispatched = true
        var response = Teamclu_RpcResponse()
        response.requestID = rpcRequest.requestID
        response.success = true
        response.result = .runtimeCommandResult(result)
        mqtt.deliverForTesting(MQTTIncoming(
            topic: MQTTTopics.actorRpcResponse(teamID: "team-1", actorID: requesterActorID),
            payload: try response.serializedData(),
            retained: false
        ))
    }

    private func makeAgent(actorID: String, runtimeID: String?) -> MemberSheetAgent {
        MemberSheetAgent(
            id: actorID,
            displayName: actorID,
            workspacePath: "",
            agentType: "Claude",
            lifecycleState: .ready,
            availableModels: [],
            currentModel: nil,
            workspaceID: nil,
            backendType: "claude"
        )
    }

    func testStartPrunesPersistedSameAgentOutputPrefixDuplicate() async throws {
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        context.insert(session)

        let full = AgentEvent(agentId: "session-1", sequence: 41, eventType: "output")
        full.senderActorID = "agent-1"
        full.text = "I found the existing iOS pieces:\n- CreateIdeaSheet\n- AttachmentUploadManager"
        full.isComplete = true
        full.supabaseMessageId = "sb-full"
        full.turnID = "turn-1"
        full.timestamp = Date(timeIntervalSince1970: 1)
        context.insert(full)

        let prefix = AgentEvent(agentId: "session-1", sequence: 640, eventType: "output")
        prefix.senderActorID = "agent-1"
        prefix.text = "I found the existing iOS pieces:"
        prefix.isComplete = true
        prefix.timestamp = Date(timeIntervalSince1970: 2)
        context.insert(prefix)
        try context.save()

        let mqtt = MQTTService()
        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamcluService: nil
        )

        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        XCTAssertEqual(viewModel.events.filter { $0.eventType == "output" }.count, 1)
        XCTAssertEqual(viewModel.events.first?.text, full.text)
        XCTAssertEqual(viewModel.events.first?.supabaseMessageId, "sb-full")
    }

    func testSessionPromptUsesSessionLiveTransportEvenWithPlaceholderRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let teamcluService = TeamcluService()
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamcluService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamcluService.setLocalMemberIdForTesting("human-1")

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"

        let viewModel = SessionDetailViewModel(
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamcluService: teamcluService
        )

        try await viewModel.sendPrompt("second turn")
        try await Task.sleep(for: .milliseconds(50))

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertEqual(
            snapshot.first?.0,
            MQTTTopics.sessionLive(teamID: "team-1", sessionID: "session-1")
        )
        XCTAssertFalse(snapshot.first?.2 ?? true)
    }

    func testGrantPermissionRoutesToPermissionSourceRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let teamcluService = TeamcluService()
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamcluService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamcluService.setLocalMemberIdForTesting("human-1")
        await teamcluService.hubRef?.start()

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-primary"

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamcluService: teamcluService
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-primary", runtimeID: "rt-primary"),
            makeAgent(actorID: "agent-secondary", runtimeID: "rt-secondary")
        ])

        async let work: Void = viewModel.grantPermission(requestId: "perm-1", agentActorID: "agent-secondary")

        // Commands ride the RPC channel (ADR-0003), addressed to the agent
        // actor's rpc/req topic, carrying (session, actor) — the daemon
        // resolves its internal spawn key, which it never publishes.
        let data = try await awaitPublish(
            published,
            onTopic: MQTTTopics.actorRpcRequest(teamID: "team-1", actorID: "agent-secondary")
        )
        let rpcRequest = try Teamclu_RpcRequest(serializedBytes: data)
        guard case .runtimeCommand(let command) = rpcRequest.method else {
            return XCTFail("expected runtime_command RPC, got \(String(describing: rpcRequest.method))")
        }
        XCTAssertEqual(command.sessionID, "session-1")
        XCTAssertEqual(command.envelope.actorID, "agent-secondary")
        XCTAssertEqual(command.envelope.runtimeID, "agent-secondary::session-1")
        XCTAssertEqual(command.envelope.senderActorID, "human-1")
        if case .grantPermission(let grant) = command.envelope.acpCommand.command {
            XCTAssertEqual(grant.requestID, "perm-1")
        } else {
            XCTFail("expected grantPermission ACP command")
        }

        try replyDispatched(mqtt, rpcRequest: rpcRequest, requesterActorID: "human-1")
        try await work
    }

    func testGrantPermissionRoutesEvenWhenDetailRuntimeIsNil() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-secondary"
        context.insert(session)

        try context.save()

        let teamcluService = TeamcluService()
        teamcluService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamcluService.setLocalMemberIdForTesting("human-1")
        await teamcluService.hubRef?.start()

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamcluService: teamcluService
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-secondary", runtimeID: "rt-secondary")
        ])
        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        async let work: Void = viewModel.grantPermission(requestId: "perm-2", agentActorID: "agent-secondary")

        let data = try await awaitPublish(
            published,
            onTopic: MQTTTopics.actorRpcRequest(teamID: "team-1", actorID: "agent-secondary")
        )
        let rpcRequest = try Teamclu_RpcRequest(serializedBytes: data)
        guard case .runtimeCommand(let command) = rpcRequest.method else {
            return XCTFail("expected runtime_command RPC, got \(String(describing: rpcRequest.method))")
        }
        XCTAssertEqual(command.sessionID, "session-1")
        XCTAssertEqual(command.envelope.runtimeID, "agent-secondary::session-1")
        if case .grantPermission(let grant) = command.envelope.acpCommand.command {
            XCTAssertEqual(grant.requestID, "perm-2")
        } else {
            XCTFail("expected grantPermission ACP command")
        }

        try replyDispatched(mqtt, rpcRequest: rpcRequest, requesterActorID: "human-1")
        try await work
    }

    /// Regression test for "agent loading takes a long time after send".
    ///
    /// Before the fix, the `ActiveStreamCardView` was driven solely by
    /// `streamingAgentSet`, which only got populated when the first ACP
    /// text delta arrived over MQTT — typically seconds after the user
    /// tapped send. After the fix, `recomputeGroups()` unions
    /// `streamingAgentSet` with the computed `streamingAgentIDs` (which
    /// reads `isAgentWorking`), and `markAgentWorking()` triggers a
    /// re-render. So feedItems must contain an `.activeStream` for the
    /// engaged agent immediately after `sendPrompt` returns.
    func testSendPromptSurfacesActiveStreamCardImmediately() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, _, _ in }
        )
        let teamcluService = TeamcluService()
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamcluService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamcluService.setLocalMemberIdForTesting("human-1")

        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"
        context.insert(session)
        try context.save()

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamcluService: teamcluService
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-actor-1", runtimeID: "agent-actor-1")
        ])
        // The send has to mention the agent: an unmentioned message is
        // silent-queued by the daemon and raises no card (see
        // `testSendPromptWithoutAgentMentionRaisesNoCard`).
        viewModel.lightAgentChip("agent-actor-1")

        // Precondition: no busy state and no active-stream card.
        XCTAssertFalse(viewModel.isAgentWorking)
        XCTAssertFalse(viewModel.feedItems.contains(where: { item in
            if case .activeStream = item { return true }
            return false
        }))

        try await viewModel.sendPrompt("hello", modelContext: context)

        // Postcondition: busy flag is up AND the feed shows the
        // active-stream card for the engaged agent — without waiting
        // for any ACP delta to round-trip.
        XCTAssertTrue(viewModel.isAgentWorking)
        let activeStreamForAgent = viewModel.feedItems.contains { item in
            if case .activeStream(_, let agentID, let runtimeEvents) = item {
                return agentID == "agent-actor-1" && runtimeEvents.isEmpty
            }
            return false
        }
        XCTAssertTrue(
            activeStreamForAgent,
            "Expected an .activeStream feed item for agent-actor-1 with empty runtimeEvents immediately after sendPrompt"
        )
    }

    /// A message that mentions no agent is silent-queued by the daemon, so
    /// no agent is going to answer it. The "Agent loading…" card used to go
    /// up anyway — in a single-agent session `streamingAgentIDs` pins the
    /// busy flag on the only agent — and sat there until the 60s reset.
    func testSendPromptWithoutAgentMentionRaisesNoCard() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, _, _ in }
        )
        let teamcluService = TeamcluService()
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamcluService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamcluService.setLocalMemberIdForTesting("human-1")

        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"
        context.insert(session)
        try context.save()

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamcluService: teamcluService
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-actor-1", runtimeID: "agent-actor-1")
        ])
        XCTAssertTrue(viewModel.agentChipSelection.isEmpty)

        try await viewModel.sendPrompt("还可以", modelContext: context)

        XCTAssertFalse(viewModel.isAgentWorking)
        XCTAssertFalse(viewModel.feedItems.contains { item in
            if case .activeStream = item { return true }
            return false
        })
    }

    func testInterruptAgentInSessionModePublishesCancelToThatAgentsRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let teamcluService = TeamcluService()
        let container = try ModelContainer(
            for: Session.self, AgentAttachment.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamcluService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamcluService.setLocalMemberIdForTesting("human-1")

        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"
        context.insert(session)
        try context.save()

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamcluService: teamcluService
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-actor-1", runtimeID: "rt-mini-1")
        ])
        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        await teamcluService.hubRef?.start()
        viewModel.interruptAgent("agent-actor-1")

        let data = try await awaitPublish(
            published,
            onTopic: MQTTTopics.actorRpcRequest(teamID: "team-1", actorID: "agent-actor-1")
        )
        let rpcRequest = try Teamclu_RpcRequest(serializedBytes: data)
        guard case .runtimeCommand(let command) = rpcRequest.method else {
            return XCTFail("expected runtime_command RPC, got \(String(describing: rpcRequest.method))")
        }
        XCTAssertEqual(command.sessionID, "session-1")
        XCTAssertEqual(command.envelope.runtimeID, "agent-actor-1::session-1")
        XCTAssertEqual(command.envelope.actorID, "agent-actor-1")
        XCTAssertEqual(command.envelope.senderActorID, "human-1")
        guard case .cancel = command.envelope.acpCommand.command else {
            return XCTFail("expected AcpCancel command")
        }

        // Let the fire-and-forget interrupt task finish instead of leaving
        // it waiting out the RPC timeout.
        try replyDispatched(mqtt, rpcRequest: rpcRequest, requesterActorID: "human-1")
        try await Task.sleep(for: .milliseconds(50))
    }
}
