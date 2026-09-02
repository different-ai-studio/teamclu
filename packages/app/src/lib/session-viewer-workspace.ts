import type { DaemonWorkspace } from "@/lib/daemon-workspaces";
import type { SessionWorkspaceRow } from "@/lib/local-cache";

/** Viewer + local machine context for session workspace resolution. */
export type ViewerWorkspaceContext = {
  memberId: string | null;
  localDaemonAgentId: string | null;
  ownedAgentIds: ReadonlySet<string>;
  localWorkspacesByCloudId: Map<string, { path: string; agentId: string | null }>;
};

type ViewerSessionBinding = {
  agentId: string;
  cloudWorkspaceId: string;
  localPath: string | null;
  updatedAt: string;
};

function indexLocalWorkspaces(
  workspaces: DaemonWorkspace[],
): Map<string, { path: string; agentId: string | null }> {
  const out = new Map<string, { path: string; agentId: string | null }>();
  for (const ws of workspaces) {
    if (ws.archived) continue;
    const id = ws.id?.trim();
    const path = ws.path?.trim();
    if (!id || !path) continue;
    out.set(id, { path, agentId: ws.agentId });
  }
  return out;
}

// Resolving a session's workspace on every sidebar click rebuilds this context
// from scratch — daemon IPC (agent id, workspaces) plus a Cloud API round-trip
// (connected agents). Cache it per team for a short window so a burst of clicks
// shares one build. The data changes rarely (agents connect / workspaces
// register), so a few seconds of staleness is invisible; call
// `invalidateViewerWorkspaceContext()` when it must be refreshed immediately.
const VIEWER_CONTEXT_TTL_MS = 5_000;
const viewerContextCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ViewerWorkspaceContext> }
>();

/** Drop cached viewer context (all teams, or one) so the next load rebuilds it. */
export function invalidateViewerWorkspaceContext(teamId?: string): void {
  if (teamId) viewerContextCache.delete(teamId);
  else viewerContextCache.clear();
}

/** Load the current member, owned agents, and locally registered workspace paths. */
export async function loadViewerWorkspaceContext(
  teamId: string,
): Promise<ViewerWorkspaceContext> {
  const now = Date.now();
  const cached = viewerContextCache.get(teamId);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = buildViewerWorkspaceContext(teamId);
  viewerContextCache.set(teamId, {
    expiresAt: now + VIEWER_CONTEXT_TTL_MS,
    promise,
  });
  // If the build rejects, don't cache the failure — let the next call retry.
  promise.catch(() => viewerContextCache.delete(teamId));
  return promise;
}

async function buildViewerWorkspaceContext(
  teamId: string,
): Promise<ViewerWorkspaceContext> {
  const { useCurrentTeamStore } = await import("@/stores/current-team");
  const memberId = useCurrentTeamStore.getState().currentMember?.id ?? null;

  const [{ getLocalDaemonActorId }, { listDaemonWorkspaces }, { getBackend }] =
    await Promise.all([
      import("@/lib/daemon-agent-admin"),
      import("@/lib/daemon-workspaces"),
      import("@/lib/backend"),
    ]);

  const localDaemonAgentId = await getLocalDaemonActorId();
  const localWorkspaces = await listDaemonWorkspaces(teamId).catch(() => []);

  const ownedAgentIds = new Set<string>();
  if (localDaemonAgentId) ownedAgentIds.add(localDaemonAgentId);

  try {
    const connected = await getBackend().actors.listConnectedAgents(teamId);
    for (const row of connected) {
      if (!row.is_owner) continue;
      const id = row.agent_id?.trim() || row.id?.trim();
      if (id) ownedAgentIds.add(id);
    }
  } catch {
    // Offline — local daemon id is enough for the common desktop path.
  }

  return {
    memberId,
    localDaemonAgentId,
    ownedAgentIds,
    localWorkspacesByCloudId: indexLocalWorkspaces(localWorkspaces),
  };
}

export function isViewerAgent(
  agentId: string,
  ctx: ViewerWorkspaceContext,
): boolean {
  return ctx.ownedAgentIds.has(agentId.trim());
}

/** Map a cloud workspace UUID to a path registered on this machine's daemon. */
export function resolveLocalPathForCloudWorkspace(
  cloudWorkspaceId: string | null | undefined,
  ctx: ViewerWorkspaceContext,
): string | null {
  const id = cloudWorkspaceId?.trim();
  if (!id) return null;
  return ctx.localWorkspacesByCloudId.get(id)?.path ?? null;
}

/** Pick the best locally adoptable path from viewer-owned session bindings. */
export function pickBestViewerSessionPath(
  bindings: ViewerSessionBinding[],
  viewer: ViewerWorkspaceContext,
): string | null {
  if (bindings.length === 0) return null;

  const daemonBinding = viewer.localDaemonAgentId
    ? bindings.find(
        (b) => b.agentId === viewer.localDaemonAgentId && b.localPath,
      )
    : null;
  if (daemonBinding?.localPath) return daemonBinding.localPath;

  const accessible = bindings.filter((b) => b.localPath);
  if (accessible.length === 0) return null;

  accessible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return accessible[0].localPath;
}

export function bindingsFromCacheRows(
  rows: SessionWorkspaceRow[],
  viewer: ViewerWorkspaceContext,
  sessionId: string,
): ViewerSessionBinding[] {
  const bindings: ViewerSessionBinding[] = [];
  for (const row of rows) {
    if (row.sessionId !== sessionId) continue;
    const cloudId = row.workspaceId?.trim();
    if (!cloudId) continue;
    const cachedPath = row.workspacePath?.trim() || null;
    bindings.push({
      agentId: row.agentId,
      cloudWorkspaceId: cloudId,
      localPath:
        cachedPath ?? resolveLocalPathForCloudWorkspace(cloudId, viewer),
      updatedAt: row.updatedAt,
    });
  }
  return bindings;
}

/**
 * Workspace bindings for one session, from its participant rows.
 *
 * This used to pull every runtime row in the team and filter client-side —
 * the query that reached 1306 rows and produced a 48KB URL. The workspace
 * belongs to the participant now (ADR-0005), so one session costs one call.
 */
async function bindingsFromRuntimes(
  teamId: string,
  sessionId: string,
  viewer: ViewerWorkspaceContext,
): Promise<ViewerSessionBinding[]> {
  const { getBackend } = await import("@/lib/backend");
  const participants = await getBackend()
    .sessions.getSessionParticipants(sessionId)
    .catch(() => []);
  const now = new Date().toISOString();
  const bindings: ViewerSessionBinding[] = [];

  for (const row of participants) {
    if (!isViewerAgent(row.actor_id, viewer)) continue;
    const cloudId = row.workspaceId?.trim();
    if (!cloudId) continue;
    bindings.push({
      agentId: row.actor_id,
      cloudWorkspaceId: cloudId,
      localPath: resolveLocalPathForCloudWorkspace(cloudId, viewer),
      updatedAt: now,
    });
  }
  return bindings;
}

async function bindingsFromViewerCache(
  teamId: string,
  sessionId: string,
  viewer: ViewerWorkspaceContext,
): Promise<ViewerSessionBinding[]> {
  if (!viewer.memberId) return [];
  const { loadSessionWorkspacesForTeam } = await import("@/lib/local-cache");
  const rows = await loadSessionWorkspacesForTeam(
    teamId,
    viewer.memberId,
  ).catch(() => []);
  return bindingsFromCacheRows(rows, viewer, sessionId);
}

/**
 * Resolve which local workspace path the viewer should adopt when opening a
 * session. Returns null for observers or when no locally registered path exists
 * — never returns another member's filesystem path.
 */
export async function resolveSessionWorkspaceForViewer(
  teamId: string,
  sessionId: string,
  ctx?: ViewerWorkspaceContext,
): Promise<string | null> {
  const viewer = ctx ?? (await loadViewerWorkspaceContext(teamId));

  let bindings = await bindingsFromRuntimes(teamId, sessionId, viewer);
  if (bindings.length === 0) {
    bindings = await bindingsFromViewerCache(teamId, sessionId, viewer);
  }

  return pickBestViewerSessionPath(bindings, viewer);
}

/** Best workspace label for a session from viewer-scoped cache rows. */
export function pickSessionWorkspaceLabel(
  rows: SessionWorkspaceRow[],
  sessionId: string,
  viewer: ViewerWorkspaceContext,
): string | null {
  const bindings = bindingsFromCacheRows(rows, viewer, sessionId);
  const path = pickBestViewerSessionPath(bindings, viewer);
  if (path) {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.split("/").pop() || trimmed;
  }
  const newest = bindings.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )[0];
  return newest?.cloudWorkspaceId ?? null;
}
