import { fromBinary } from "@bufbuild/protobuf";
import { ActorPresenceSchema } from "@teamclu/app/proto/amux_pb";

import type { RuntimeAvailableCommand, RuntimeInfo } from "./connected-agent-types";

/**
 * An agent's retained `amux/{team}/{actor}/state` message (`ActorPresence`,
 * ADR-0004) — the single per-actor topic that replaced the per-spawn
 * `…/runtime/{runtime_id}/state` fan-out. The daemon no longer publishes the
 * old topic, so anything still subscribed to it sees nothing.
 *
 * An attachment is keyed by (actor, session) and has no runtime id. Mirrors
 * iOS `SessionListViewModel.syncActorPresence`.
 */
export type LiveSessionInfo = {
  sessionId: string;
  /** `RuntimeLifecycle`: 1 starting, 2 active, 3 failed. */
  lifecycle: number;
  /** `AgentStatus`: 1 starting … 5 stopped. */
  status: number;
  stage: string;
  errorCode: string;
  errorMessage: string;
  failedStage: string;
  workspaceId: string;
  currentModel: string;
  worktree: string;
};

export type ActorPresenceSnapshot = {
  /** False for the daemon's Last Will and for a cleared retain (empty payload). */
  online: boolean;
  /** `AgentType` enum value of the backend running right now. */
  activeAgentType: number;
  models: { id: string; displayName: string }[];
  availableCommands: RuntimeAvailableCommand[];
  liveSessions: LiveSessionInfo[];
};

export const OFFLINE_PRESENCE: ActorPresenceSnapshot = {
  online: false,
  activeAgentType: 0,
  models: [],
  availableCommands: [],
  liveSessions: [],
};

export function decodeActorPresence(payload: Uint8Array): ActorPresenceSnapshot | null {
  // A cleared retain is an empty payload; it decodes to the defaults, which is
  // exactly "offline, nothing attached".
  if (payload.byteLength === 0) return OFFLINE_PRESENCE;
  try {
    const p = fromBinary(ActorPresenceSchema, payload);
    // `catalog_models` is the device-level catalog; the default workspace's
    // probed list is the fallback while the catalog is still empty.
    const source = p.catalogModels.length > 0 ? p.catalogModels : p.defaultWorkspaceModels;
    const seen = new Set<string>();
    const models: { id: string; displayName: string }[] = [];
    for (const m of source) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      models.push({ id: m.id, displayName: m.displayName || m.id });
    }
    return {
      online: p.online,
      activeAgentType: p.activeAgentType,
      models,
      availableCommands: p.availableCommands.map((c) => ({
        name: c.name,
        description: c.description,
        inputHint: c.inputHint,
      })),
      liveSessions: p.liveSessions.map((s) => ({
        sessionId: s.sessionId,
        lifecycle: s.lifecycle,
        status: s.status,
        stage: s.stage,
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
        failedStage: s.failedStage,
        workspaceId: s.workspaceId,
        currentModel: s.currentModel,
        worktree: s.worktree,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * The attachment an agent holds for `sessionId`, in the `RuntimeInfo` shape the
 * session screens were written against. Absent when the agent is cold for this
 * session. `runtimeId` carries the session id: it is only a stable key now,
 * never an address — commands go by (actor, session) over RPC.
 */
export function runtimeInfoForSession(
  presence: ActorPresenceSnapshot | undefined,
  sessionId: string,
): RuntimeInfo | undefined {
  if (!presence || !sessionId) return undefined;
  const live = presence.liveSessions.find((s) => s.sessionId === sessionId);
  if (!live) return undefined;
  return {
    runtimeId: live.sessionId,
    agentType: presence.activeAgentType,
    worktree: live.worktree,
    branch: "",
    status: live.status,
    startedAt: 0,
    currentPrompt: "",
    workspaceId: live.workspaceId,
    sessionTitle: "",
    toolUseCount: 0,
    availableModels: presence.models,
    currentModel: live.currentModel,
    state: live.lifecycle,
    stage: live.stage,
    errorCode: live.errorCode,
    errorMessage: live.errorMessage,
    failedStage: live.failedStage,
    availableCommands: presence.availableCommands,
  };
}

/** `agentId → RuntimeInfo` for the agents attached to one session. */
export function runtimeInfoByAgentForSession(
  presenceByAgentId: ReadonlyMap<string, ActorPresenceSnapshot>,
  sessionId: string,
): Map<string, RuntimeInfo> {
  const out = new Map<string, RuntimeInfo>();
  for (const [agentId, presence] of presenceByAgentId) {
    const info = runtimeInfoForSession(presence, sessionId);
    if (info) out.set(agentId, info);
  }
  return out;
}
