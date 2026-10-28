import Foundation
import SwiftData

/// One agent actor's live attachment to one session, projected from the
/// `ActorPresence` retained on `amux/{team}/{actor}/state`.
///
/// This replaces the old `Runtime` row. The difference is the key: `Runtime`
/// was keyed by a per-spawn id minted fresh on every start and broadcast on a
/// topic that no longer exists, so it was stale the moment it was written
/// (ADR-0004). An attachment is keyed by `(actor, session)` — a daemon holds
/// at most one attachment per session, so the key is stable across restarts.
///
/// **Absence means cold, not missing.** A session with no attachment row is one
/// no daemon is currently serving; the next message spawns one. That is a
/// normal state, not a failed lookup.
///
/// Fields the old row carried and this one deliberately drops (ADR-0004):
/// `sessionTitle` duplicated `sessions.title`; `currentPrompt`,
/// `lastOutputSummary`, `toolUseCount` and `startedAt` were only snapshotted on
/// discrete lifecycle events and went stale in between. `LiveSession` does not
/// carry them, so there is nothing to project.
@Model
public final class AgentAttachment {
    /// `"{actorID}::{sessionID}"` — also the command address the daemon's
    /// `resolve_command_agent_id` accepts, so no separate routing id is needed.
    @Attribute(.unique) public var id: String

    /// The agent actor that owns this attachment. This is the bucket key for
    /// timeline events and the target of RPC/commands.
    public var actorID: String
    public var sessionID: String

    /// `Amux_RuntimeLifecycle` raw value.
    public var lifecycle: Int
    /// `Amux_AgentStatus` raw value.
    public var status: Int
    /// `Amux_AgentType` raw value, from `ActorPresence.active_agent_type`.
    /// One actor runs exactly one backend at a time (ADR-0002).
    public var agentType: Int

    /// Meaningful iff `lifecycle == STARTING`.
    public var stage: String
    /// Meaningful iff `lifecycle == FAILED`.
    public var errorCode: String
    public var errorMessage: String
    public var failedStage: String

    public var workspaceID: String
    /// Local directory this attachment runs in. Added in the same daemon change
    /// that dropped the per-spawn retain — it is what lets a multi-checkout
    /// device pick the right model catalog instead of guessing.
    public var worktree: String

    public var currentModel: String?
    /// JSON `[AvailableModel]`, resolved from `ActorPresence.catalog_models`
    /// through this worktree's `model_indices`. SwiftData does not store
    /// `[Codable]` arrays cleanly, hence the JSON column.
    public var availableModelsJSON: String
    /// JSON `[SlashCommand]`, from this worktree's `available_commands`.
    public var availableCommandsJSON: String

    public var lastEventTime: Date?

    public init(
        actorID: String,
        sessionID: String,
        lifecycle: Int = 0,
        status: Int = 0,
        agentType: Int = 0,
        stage: String = "",
        errorCode: String = "",
        errorMessage: String = "",
        failedStage: String = "",
        workspaceID: String = "",
        worktree: String = "",
        currentModel: String? = nil,
        availableModelsJSON: String = "",
        availableCommandsJSON: String = "",
        lastEventTime: Date? = nil
    ) {
        self.id = AgentAttachment.makeID(actorID: actorID, sessionID: sessionID)
        self.actorID = actorID
        self.sessionID = sessionID
        self.lifecycle = lifecycle
        self.status = status
        self.agentType = agentType
        self.stage = stage
        self.errorCode = errorCode
        self.errorMessage = errorMessage
        self.failedStage = failedStage
        self.workspaceID = workspaceID
        self.worktree = worktree
        self.currentModel = currentModel
        self.availableModelsJSON = availableModelsJSON
        self.availableCommandsJSON = availableCommandsJSON
        self.lastEventTime = lastEventTime
    }

    /// The composite key, and the address commands are sent to.
    public static func makeID(actorID: String, sessionID: String) -> String {
        "\(actorID)::\(sessionID)"
    }

    public var isActive: Bool { status == 2 }
    public var isIdle: Bool { status == 3 }

    public var statusLabel: String {
        switch status {
        case 1: String(localized: "Starting")
        case 2: String(localized: "Active")
        case 3: String(localized: "Idle")
        case 4: String(localized: "Error")
        case 5: String(localized: "Stopped")
        default: String(localized: "Unknown")
        }
    }

    public var agentTypeLabel: String {
        switch agentType {
        case 1: "Claude Code"
        case 2: "OpenCode"
        case 3: "Codex"
        case 4: "pi"
        case 5: "Cursor"
        default: String(localized: "Unknown")
        }
    }
}

public extension AgentAttachment {
    var availableModels: [AvailableModel] {
        guard !availableModelsJSON.isEmpty,
              let data = availableModelsJSON.data(using: .utf8),
              let models = try? JSONDecoder().decode([AvailableModel].self, from: data)
        else { return [] }
        return models
    }

    var availableCommands: [SlashCommand] {
        guard !availableCommandsJSON.isEmpty,
              let data = availableCommandsJSON.data(using: .utf8),
              let cmds = try? JSONDecoder().decode([SlashCommand].self, from: data)
        else { return [] }
        return cmds
    }

    /// Display name for `modelId` as `attachment` lists it, else the raw id;
    /// nil when no model is given. A nil attachment (agent no longer attached
    /// here) still yields the raw id so older replies keep their model label.
    static func modelDisplayName(for modelId: String?, via attachment: AgentAttachment?) -> String? {
        guard let modelId, !modelId.isEmpty else { return nil }
        return attachment?.availableModels.first(where: { $0.id == modelId })?.displayName ?? modelId
    }
}
