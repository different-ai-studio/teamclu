import { runtimeInfoForSession, type ActorPresenceSnapshot } from "../actors/actor-presence";
import type { RuntimeInfo } from "../actors/connected-agent-types";
import type { SessionRowRuntime } from "./components/SessionRow";
import type { SessionSummary } from "./session-types";

/**
 * Resolves the live runtime attachment behind each session row, so the sessions
 * list can render the badge dot, the status label and the workspace name that
 * iOS's `AgentRowView` shows.
 *
 * iOS reads these off a per-session `AgentAttachment` in SwiftData. Expo has no
 * attachment cache (see the persistence axis in
 * `docs/expo-ios-parity-audit.md`), so the same facts are stitched from the
 * connected-agents store: a session's runtime is the runtime of whichever agent
 * participant currently has one.
 */

/** Mirrors iOS `AgentAttachment.statusLabel`. */
export function runtimeStatusLabel(status: number | undefined): string {
  switch (status) {
    case 1:
      return "Starting";
    case 2:
      return "Active";
    case 3:
      return "Idle";
    case 4:
      return "Error";
    case 5:
      return "Stopped";
    default:
      return "";
  }
}

/**
 * Workspace label for a runtime. iOS looks `workspaceId` up in its cached
 * `Workspace` rows for a display name; without that cache we fall back to the
 * worktree's last path segment, which is what those display names are derived
 * from anyway.
 */
export function runtimeWorkspaceName(
  runtime: RuntimeInfo,
  workspaceNamesById?: ReadonlyMap<string, string>,
): string {
  const named = runtime.workspaceId
    ? workspaceNamesById?.get(runtime.workspaceId)
    : undefined;
  if (named) return named;
  const worktree = runtime.worktree?.trim() ?? "";
  if (!worktree) return "";
  return worktree.split("/").filter(Boolean).pop() ?? "";
}

export function buildSessionRuntimeMaps(args: {
  sessions: ReadonlyArray<SessionSummary>;
  presenceByAgentId: ReadonlyMap<string, ActorPresenceSnapshot>;
  agentActorIds: ReadonlySet<string>;
  workspaceNamesById?: ReadonlyMap<string, string>;
}): {
  runtimeBySessionId: Map<string, SessionRowRuntime>;
  workspaceBySessionId: Map<string, string>;
} {
  const runtimeBySessionId = new Map<string, SessionRowRuntime>();
  const workspaceBySessionId = new Map<string, string>();

  for (const session of args.sessions) {
    for (const actorId of session.participantActorIds) {
      if (!args.agentActorIds.has(actorId)) continue;
      // This session's own attachment — not "the agent's runtime", which
      // painted every session an agent was in with one session's status.
      const runtime = runtimeInfoForSession(args.presenceByAgentId.get(actorId), session.sessionId);
      if (!runtime) continue;
      runtimeBySessionId.set(session.sessionId, {
        status: runtime.status,
        agentType: runtime.agentType,
        statusLabel: runtimeStatusLabel(runtime.status),
      });
      const workspace = runtimeWorkspaceName(runtime, args.workspaceNamesById);
      if (workspace) workspaceBySessionId.set(session.sessionId, workspace);
      // First agent participant with a live runtime wins — a session has one
      // primary agent, and a second attachment would be a stale duplicate.
      break;
    }
  }

  return { runtimeBySessionId, workspaceBySessionId };
}
