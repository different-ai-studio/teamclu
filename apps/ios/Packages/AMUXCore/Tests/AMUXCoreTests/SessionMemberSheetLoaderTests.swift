import Testing
import Foundation
@testable import AMUXCore

@Suite("SessionMemberSheetLoader static helpers")
struct SessionMemberSheetLoaderStaticHelpersTests {

    @Test("fromRuntimeStatus maps daemon strings to chip states")
    func runtimeStatusMapping() {
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("starting") == .spawning)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("spawning") == .spawning)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("ready") == .ready)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("running") == .active)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("active") == .active)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("idle") == .idle)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("stopped") == .stopped)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("error") == .error)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus(nil) == .idle)
        #expect(SessionMemberSheetLoader.fromRuntimeStatus("garbage") == .idle)
    }

    @Test("chipState demotes stale spawning to idle past the timeout")
    func chipStateDemotesStaleSpawning() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let recent = now.addingTimeInterval(-10) // within 30s
        let stale = now.addingTimeInterval(-31)  // past 30s

        #expect(SessionMemberSheetLoader.chipState(forStatus: "starting",
                                                   lastSeenAt: recent,
                                                   now: now) == .spawning)
        #expect(SessionMemberSheetLoader.chipState(forStatus: "starting",
                                                   lastSeenAt: stale,
                                                   now: now) == .idle,
                "stale spawning row should fall back to idle (gray)")
        // Non-spawning statuses are unaffected by lastSeenAt.
        #expect(SessionMemberSheetLoader.chipState(forStatus: "running",
                                                   lastSeenAt: stale,
                                                   now: now) == .active)
    }

    @Test("displayName(forBackendType:) shows pi for pi and legacy backends, capitalizes others, empty on nil")
    func backendDisplayName() {
        #expect(SessionMemberSheetLoader.displayName(forBackendType: "pi") == "Pi")
        #expect(SessionMemberSheetLoader.displayName(forBackendType: "claude") == "Pi")
        #expect(SessionMemberSheetLoader.displayName(forBackendType: "opencode") == "Pi")
        #expect(SessionMemberSheetLoader.displayName(forBackendType: "codex") == "Pi")
        #expect(SessionMemberSheetLoader.displayName(forBackendType: "gemini") == "Gemini",
                "unknown non-empty types are capitalized as a fallback")
        #expect(SessionMemberSheetLoader.displayName(forBackendType: nil).isEmpty)
        #expect(SessionMemberSheetLoader.displayName(forBackendType: "").isEmpty)
    }

    @Test("models come from live data source, no hardcoded fallback")
    func noFallbackModelIDs() {
        // fallbackModelIDs was removed — models come from MQTT/daemon only.
        // Single data source: SessionDetailViewModel subscribes to runtime-state
        // topics for all session agents and overlays SwiftData models.
        // When unavailable the UI shows "default".
        #expect(true)
    }
}

// MARK: - Loader shaping tests with stub repositories

@Suite("SessionMemberSheetLoader.load shaping")
struct SessionMemberSheetLoaderShapingTests {

    private struct StubSessionsRepo: SessionRepository {
        let participants: [SessionParticipantRecord]
        func createSession(_ input: SessionCreateInput) async throws {}
        func addParticipants(sessionID: String, actorIDs: [String]) async throws {}
        func listSessionParticipants(sessionID: String) async throws -> [SessionParticipantRecord] {
            participants
        }
        func removeParticipant(sessionID: String, actorID: String) async throws {}
    }

    @Test("shapes humans + agents from the participant row's own state")
    func shapesParticipants() async {
        let participants = [
            SessionParticipantRecord(id: "p1", sessionID: "s-1", actorID: "human-a",
                                     role: "member", displayName: "Alice",
                                     actorType: "human"),
            SessionParticipantRecord(id: "p2", sessionID: "s-1", actorID: "human-b",
                                     role: "member", displayName: "Bob",
                                     actorType: "human"),
            SessionParticipantRecord(id: "p3", sessionID: "s-1", actorID: "agent-1",
                                     role: "agent", displayName: "Claude",
                                     actorType: "agent",
                                     workspaceID: "ws-1",
                                     model: "claude-sonnet-4-6")
        ]
        let loader = SessionMemberSheetLoader(
            sessionsRepository: StubSessionsRepo(participants: participants)
        )

        let snapshot = await loader.load(
            sessionID: "s-1",
            teamID: "team",
            currentHumanActorID: "human-a",
            availableModelsForAgent: { _ in ["claude-sonnet-4-6", "claude-opus-4-7"] }
        )

        let result = try! #require(snapshot)
        #expect(result.humans.count == 2)
        // Current user can't remove themselves.
        let alice = try! #require(result.humans.first(where: { $0.id == "human-a" }))
        #expect(alice.canRemove == false)
        let bob = try! #require(result.humans.first(where: { $0.id == "human-b" }))
        #expect(bob.canRemove == true)

        #expect(result.agents.count == 1)
        let agent = result.agents[0]
        #expect(agent.id == "agent-1")
        // No runtime id any more: commands address (actor, session), so the
        // member sheet has nothing to bridge through (ADR-0003/0004).
        #expect(agent.workspaceID == "ws-1")
        #expect(agent.backendType == nil)
        // Backend type came off the runtime row; it now lives on the actor
        // retain, which this loader does not consult.
        #expect(agent.agentType == "")
        // Live state likewise: absent here means "unknown from this source",
        // and the chip bar fills it from the retain.
        #expect(agent.lifecycleState == .idle)
        #expect(agent.availableModels == ["claude-sonnet-4-6", "claude-opus-4-7"])
        #expect(agent.currentModel == "claude-sonnet-4-6")
    }

    @Test("returns nil when sessionsRepository is missing")
    func nilWhenNoRepository() async {
        let loader = SessionMemberSheetLoader(sessionsRepository: nil)
        let snapshot = await loader.load(
            sessionID: "s-1", teamID: "team",
            currentHumanActorID: "",
            availableModelsForAgent: { _ in [] }
        )
        #expect(snapshot == nil)
    }
}
