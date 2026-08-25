import XCTest
import SwiftData
@testable import AMUXCore

// NOTE: We intentionally do not unit-test the 15s timeout branch of
// runtimeStartRpc. That branch only fires when another message arrives
// past the deadline (the `for await` loop only re-checks Date() when a
// new value is yielded), so a faithful synthetic test would need to sit
// idle for ~15 real seconds. Leaving this untested here — integration
// coverage can exercise it if needed.

/// Simple actor-wrapped box so the `publishHook` closure (which is
/// `@Sendable` and may run on an arbitrary concurrency context) can
/// stash the captured payload for the main-actor test body to read.
actor ActorBox<T: Sendable>: Sendable {
    private(set) var value: T
    init(_ v: T) { self.value = v }
    func set(_ v: T) { self.value = v }
}

@MainActor
final class RuntimeStartRpcTests: XCTestCase {
    // MARK: - helpers

    private func makeModelContainer() throws -> ModelContainer {
        let schema = Schema([
            Session.self,
            SessionMessage.self,
            SessionIdea.self,
        ])
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: configuration)
    }

    /// Spins until the publishHook has captured a payload or we exceed
    /// `maxAttempts * 10ms`. The sleep grain is small (10ms) so the test
    /// completes quickly once the publish lands, while staying resilient
    /// to scheduling jitter on CI.
    private func awaitCapturedPayload(
        _ box: ActorBox<Data?>,
        maxAttempts: Int = 100
    ) async throws -> Data {
        var attempts = 0
        while await box.value == nil && attempts < maxAttempts {
            try await Task.sleep(for: .milliseconds(10))
            attempts += 1
        }
        guard let payload = await box.value else {
            XCTFail("publishHook never captured a payload")
            throw CancellationError()
        }
        return payload
    }

    private func configuredService(
        mqtt: MQTTService,
        teamId: String = "team1"
    ) async throws -> TeamcluService {
        let service = TeamcluService()
        let container = try makeModelContainer()
        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: teamId,
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: nil
        )
        // The daemon replies on the requester actor's rpc/res topic, so the
        // RPC awaiter subscribes there. Seed the local actor so the response
        // topic in these tests is deterministic (`member1`).
        service.setLocalMemberIdForTesting("member1")
        await service.hubRef?.start()
        await Task.yield()
        return service
    }

    // MARK: - Test 1 — happy path (accepted)

    func testRuntimeStartRpcReturnsAcceptedOnMatchingResponse() async throws {
        let captured = ActorBox<Data?>(nil)
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in
                await captured.set(payload)
            }
        )
        let service = try await configuredService(mqtt: mqtt)

        async let outcome = service.runtimeStartRpc(
            targetActorID: "agent-a",
            agentType: .claudeCode,
            workspaceId: "ws-1",
            worktree: "/tmp/work",
            sessionId: "",
            initialPrompt: "hi"
        )

        let payload = try await awaitCapturedPayload(captured)
        let req = try Teamclu_RpcRequest(serializedBytes: payload)
        XCTAssertFalse(req.requestID.isEmpty)

        var result = Teamclu_RuntimeStartResult()
        result.accepted = true
        result.runtimeID = "rt-abc"
        result.sessionID = "s-xyz"

        var response = Teamclu_RpcResponse()
        response.requestID = req.requestID
        response.success = true
        response.result = .runtimeStartResult(result)

        let responseBytes = try response.serializedData()
        mqtt.deliverForTesting(MQTTIncoming(
            topic: MQTTTopics.actorRpcResponse(teamID: "team1", actorID: "member1"),
            payload: responseBytes,
            retained: false
        ))

        let final = await outcome
        guard case .accepted(let runtimeID, let sessionID) = final else {
            return XCTFail("expected .accepted, got \(final)")
        }
        XCTAssertEqual(runtimeID, "rt-abc")
        XCTAssertEqual(sessionID, "s-xyz")
    }

    // MARK: - Test 2 — rejected with explicit rejectedReason

    func testRuntimeStartRpcReturnsRejectedWithReason() async throws {
        let captured = ActorBox<Data?>(nil)
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in
                await captured.set(payload)
            }
        )
        let service = try await configuredService(mqtt: mqtt)

        async let outcome = service.runtimeStartRpc(
            targetActorID: "agent-a",
            agentType: .claudeCode,
            workspaceId: "ws-1",
            worktree: "/tmp/work",
            sessionId: "",
            initialPrompt: "hi"
        )

        let payload = try await awaitCapturedPayload(captured)
        let req = try Teamclu_RpcRequest(serializedBytes: payload)

        var result = Teamclu_RuntimeStartResult()
        result.accepted = false
        result.rejectedReason = "no workspace"

        var response = Teamclu_RpcResponse()
        response.requestID = req.requestID
        response.success = false
        response.result = .runtimeStartResult(result)

        mqtt.deliverForTesting(MQTTIncoming(
            topic: MQTTTopics.actorRpcResponse(teamID: "team1", actorID: "member1"),
            payload: try response.serializedData(),
            retained: false
        ))

        let final = await outcome
        guard case .rejected(let reason, _) = final else {
            return XCTFail("expected .rejected, got \(final)")
        }
        XCTAssertEqual(reason, "no workspace")
    }

    // MARK: - Test 3 — rejected, fallback to response.error

    func testRuntimeStartRpcFallsBackToResponseErrorWhenReasonEmpty() async throws {
        let captured = ActorBox<Data?>(nil)
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in
                await captured.set(payload)
            }
        )
        let service = try await configuredService(mqtt: mqtt)

        async let outcome = service.runtimeStartRpc(
            targetActorID: "agent-a",
            agentType: .claudeCode,
            workspaceId: "ws-1",
            worktree: "/tmp/work",
            sessionId: "",
            initialPrompt: "hi"
        )

        let payload = try await awaitCapturedPayload(captured)
        let req = try Teamclu_RpcRequest(serializedBytes: payload)

        var result = Teamclu_RuntimeStartResult()
        result.accepted = false
        result.rejectedReason = ""

        var response = Teamclu_RpcResponse()
        response.requestID = req.requestID
        response.success = false
        response.error = "internal"
        response.result = .runtimeStartResult(result)

        mqtt.deliverForTesting(MQTTIncoming(
            topic: MQTTTopics.actorRpcResponse(teamID: "team1", actorID: "member1"),
            payload: try response.serializedData(),
            retained: false
        ))

        let final = await outcome
        guard case .rejected(let reason, _) = final else {
            return XCTFail("expected .rejected, got \(final)")
        }
        XCTAssertEqual(reason, "internal")
    }

    // MARK: - Test 4 — nil mqtt short-circuits

    func testRuntimeStartRpcReturnsRejectedWhenMQTTNotConfigured() async {
        let service = TeamcluService()
        // Intentionally no configureRuntimeForTesting — mqtt stays nil.
        let outcome = await service.runtimeStartRpc(
            targetActorID: "agent-a",
            agentType: .claudeCode,
            workspaceId: "ws-1",
            worktree: "/tmp/work",
            sessionId: "",
            initialPrompt: "hi"
        )
        guard case .rejected(let reason, _) = outcome else {
            return XCTFail("expected .rejected, got \(outcome)")
        }
        XCTAssertEqual(reason, "mqtt not configured")
    }
}
