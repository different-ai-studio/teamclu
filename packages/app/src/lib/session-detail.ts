import { getBackend } from "@/lib/backend";
import {
  loadSessionWorkspacesForTeam,
  loadSessionsForTeam,
  type SessionRow,
  type SessionWorkspaceRow,
} from "@/lib/local-cache";
import { loadViewerWorkspaceContext } from "@/lib/session-viewer-workspace";
import { isTauri } from "@/lib/utils";
import type { SessionParticipantInfo } from "@/stores/session-participant-store";
import { attachmentsForSession, type RuntimeStateEntry } from "@/stores/runtime-state-store";

export interface SessionRuntimeDetail {
  agentId: string;
  agentName: string;
  runtimeId: string | null;
  backendType: string | null;
  backendSessionId: string | null;
  dbStatus: string | null;
  dbModel: string | null;
  liveState: string | null;
  liveStatus: string | null;
  liveModel: string | null;
  agentType: string | null;
  lastSeenAt: string | null;
  workspacePath: string | null;
  workspaceId: string | null;
}

export interface SessionDetailSnapshot {
  sessionId: string;
  teamId: string | null;
  title: string;
  mode: string | null;
  ideaId: string | null;
  primaryAgentId: string | null;
  summary: string | null;
  createdByActorId: string | null;
  acpSessionId: string | null;
  binding: string | null;
  metadataJson: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  runtimes: SessionRuntimeDetail[];
  workspaces: SessionWorkspaceRow[];
  loadError: string | null;
}

interface SessionDetailHints {
  title?: string;
  mode?: string | null;
  ideaId?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

async function loadCachedSessionRow(
  teamId: string,
  sessionId: string,
): Promise<SessionRow | null> {
  if (!isTauri()) return null;
  const rows = await loadSessionsForTeam(teamId);
  return rows.find((row) => row.id === sessionId) ?? null;
}

/**
 * Per-agent runtime detail for a session, built entirely from the actor retain.
 *
 * This used to join three cloud calls — runtime-targets, runtime-models and the
 * whole team's `agent_runtimes` list — to recover a spawn id, a backend type and
 * a model. The retain carries all of it, keyed by session, so the join is gone
 * along with the endpoints (ADR-0004).
 */
function buildRuntimeDetails(
  sessionId: string,
  participants: SessionParticipantInfo[],
  liveByRuntimeId: Record<string, RuntimeStateEntry>,
): SessionRuntimeDetail[] {
  const agentIds = new Set<string>();
  for (const participant of participants) {
    if (participant.isAgent) agentIds.add(participant.actorId);
  }

  return [...agentIds].map((agentId) => {
    // This agent's own attachment to THIS session. No per-agent fallback — it
    // would surface another session's attachment here.
    const live = attachmentsForSession(sessionId, liveByRuntimeId).find(
      (entry) => entry.daemonActorId === agentId,
    );
    const participant = participants.find((row) => row.actorId === agentId);

    return {
      agentId,
      agentName: participant?.displayName ?? agentId,
      runtimeId: live?.info.runtimeId ?? null,
      backendType: null,
      backendSessionId: null,
      dbStatus: null,
      dbModel: null,
      liveState: live?.info.state != null ? String(live.info.state) : null,
      liveStatus: live?.info.status != null ? String(live.info.status) : null,
      liveModel: live?.info.currentModel ?? null,
      agentType: live?.info.agentType != null ? String(live.info.agentType) : null,
      lastSeenAt: null,
      workspacePath: null,
      workspaceId: live?.info.workspaceId ?? null,
    };
  });
}

export async function fetchSessionDetailSnapshot(args: {
  sessionId: string;
  teamId: string;
  participants: SessionParticipantInfo[];
  liveByRuntimeId: Record<string, RuntimeStateEntry>;
  hints?: SessionDetailHints;
}): Promise<SessionDetailSnapshot> {
  const { sessionId, teamId, participants, liveByRuntimeId, hints } = args;

  let loadError: string | null = null;

  const viewer = await loadViewerWorkspaceContext(teamId);

  const [remote, cached, workspaces, runtimes] = await Promise.all([
    getBackend()
      .sessions.getSession(sessionId, teamId)
      .catch((error) => {
        loadError = error instanceof Error ? error.message : String(error);
        return null;
      }),
    loadCachedSessionRow(teamId, sessionId).catch(() => null),
    viewer.memberId
      ? loadSessionWorkspacesForTeam(teamId, viewer.memberId)
          .then((rows) => rows.filter((row) => row.sessionId === sessionId))
          .catch(() => [] as SessionWorkspaceRow[])
      : Promise.resolve([] as SessionWorkspaceRow[]),
    // Synchronous now — it reads the retain rather than three cloud calls.
    Promise.resolve(buildRuntimeDetails(sessionId, participants, liveByRuntimeId)),
  ]);

  return {
    sessionId,
    teamId: remote?.team_id ?? cached?.teamId ?? teamId,
    title: remote?.title ?? cached?.title ?? hints?.title ?? "",
    mode: remote?.mode ?? cached?.mode ?? hints?.mode ?? null,
    ideaId: remote?.idea_id ?? cached?.ideaId ?? hints?.ideaId ?? null,
    primaryAgentId: remote?.primary_agent_id ?? cached?.primaryAgentId ?? null,
    summary: remote?.summary ?? cached?.summary ?? null,
    createdByActorId: remote?.created_by_actor_id ?? cached?.createdBy ?? null,
    acpSessionId: remote?.acp_session_id ?? null,
    binding: remote?.binding ?? null,
    metadataJson: cached?.metadataJson ?? null,
    createdAt: remote?.created_at ?? cached?.createdAt ?? null,
    updatedAt: remote?.updated_at ?? cached?.updatedAt ?? null,
    lastMessageAt:
      remote?.last_message_at ?? cached?.lastMessageAt ?? hints?.lastMessageAt ?? null,
    lastMessagePreview:
      remote?.last_message_preview ?? cached?.lastMessagePreview ?? hints?.lastMessagePreview ?? null,
    runtimes,
    workspaces,
    loadError,
  };
}
