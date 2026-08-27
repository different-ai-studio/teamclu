/**
 * Sessions linked to an app.
 *
 * An app may have many sessions; the user creates each one explicitly except
 * the first session opened by {@link startAppFirstSession} during app creation.
 * {@link ensureAppSession} reopens the most recent existing session only —
 * it never creates one. Use {@link createAppSessionShell} for an empty session.
 */
import { getBackend } from '@/lib/backend'
import { createSessionShell, createSessionWithFirstMessage } from '@/lib/session-create'
import { resolveCurrentMemberActorId } from '@/lib/current-actor'
import { upsertSessionWorkspacesBatch } from '@/lib/local-cache'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'
import { isTauri } from '@/lib/utils'
import { resolveAppType } from '@/lib/app-types'
import type { AppRow, AppSessionRow } from '@/lib/backend/types'

/**
 * The local daemon's per-app workdir.
 *
 * Asked of the daemon rather than computed here. This used to derive
 * `~/.amuxd[-brand]/apps/<appId>` from the home directory — a second copy of a
 * rule the daemon also owns. When the daemon's app root moved, the two answers
 * diverged silently: agent sessions opened one directory while `deploy` built
 * another, so a finished site kept deploying as the untouched seed template.
 */
export async function appWorkdirPath(
  appId: string,
  teamId?: string | null,
): Promise<string | null> {
  if (!isTauri()) return null
  const { daemonAppWorkdir } = await import('@/lib/daemon-local-client')
  const info = await daemonAppWorkdir(appId, teamId)
  return info?.workdir ?? null
}

/**
 * Pick the most-recent session for an app, ordering by
 * `lastMessageAt ?? createdAt` descending.
 */
export function pickMostRecentSession(rows: AppSessionRow[]): AppSessionRow | null {
  if (rows.length === 0) return null
  const ts = (r: AppSessionRow): number => {
    const v = r.lastMessageAt ?? r.createdAt
    const n = v ? Date.parse(v) : NaN
    return Number.isNaN(n) ? 0 : n
  }
  return rows.reduce((best, r) => (ts(r) > ts(best) ? r : best))
}

/**
 * The opening message sent on the app's behalf, built from the name the user
 * typed plus a fixed per-type prompt.
 *
 * Each one points the agent at `AGENTS.md` first — that file is where the
 * template records the build contract it must not break — and asks for a plan
 * before edits, so the first thing the user sees is a proposal rather than a
 * pile of files.
 */
export function firstPromptForApp(app: Pick<AppRow, 'name' | 'type'>): string {
  const name = app.name.trim()
  switch (resolveAppType(app.type).id) {
    case 'static_web':
      return `我要做一个静态网页：${name}\n\n先读一下 AGENTS.md 了解这个项目的结构和约束，然后告诉我你打算做成什么样（有哪些页面、大致的结构和风格），我确认后你再动手改 public/ 下的文件。`
    case 'slides':
      return `我要做一套演示材料：${name}\n\n先读一下 AGENTS.md 了解幻灯片怎么组织，然后列一个提纲给我看（每一页讲什么），我确认后你再写进 public/index.html。`
    default:
      return `我要做一个数据操作应用：${name}\n\n先读一下 AGENTS.md 了解项目结构和数据库约定，然后告诉我你打算怎么设计数据表和页面，我确认后再动手写代码。`
  }
}

interface AppSessionContext {
  teamId: string
  authUserId: string | null
  creatorActorId: string | null
  localDaemonActorId: string | null
  viewerMemberId: string | null
}

async function loadContext(app: AppRow): Promise<AppSessionContext> {
  const team = useCurrentTeamStore.getState()
  const teamId = team.team?.id ?? app.teamId
  const authUserId = useAuthStore.getState().session?.user?.id ?? null
  const { getLocalDaemonActorId } = await import('@/lib/daemon-agent-admin')
  const localDaemonActorId = await getLocalDaemonActorId().catch(() => null)
  const creatorActorId = authUserId
    ? await resolveCurrentMemberActorId(teamId, authUserId, {
        currentTeamId: teamId,
        currentMemberId: team.currentMember?.id ?? null,
      }).catch(() => null)
    : null
  return {
    teamId,
    authUserId,
    creatorActorId,
    localDaemonActorId,
    viewerMemberId: team.currentMember?.id ?? null,
  }
}

/**
 * Write the app's local checkout path onto the app's OWN cloud workspace row,
 * and return that row's id.
 *
 * An app is created with a 1:1 workspace (`apps.workspace_id`), and the cloud
 * API — which never sees a filesystem — creates it with a name and no path. A
 * path-less workspace is one the daemon cannot resolve: `apply_start_runtime`
 * falls through to whatever `worktree` the desktop sent, and when the desktop
 * had nothing to send it used the *currently open* workspace. That is how an
 * app's files ended up in whatever folder the user happened to have open.
 *
 * Filling that row in is what makes the app directory resolvable on its own,
 * from any of the four routes runtime-start tries, and on a device whose local
 * cache is cold. It also replaces the second, path-carrying workspace row the
 * desktop used to create beside it — one app, one workspace, one directory.
 *
 * Falls back to the old find-by-path-or-create for an app row old enough to
 * have no `workspaceId`.
 */
async function ensureAppWorkspaceRow(
  app: AppRow,
  appWorkdir: string,
  ctx: AppSessionContext,
): Promise<string | null> {
  if (!ctx.localDaemonActorId) return null
  const { listDaemonWorkspaces, createDaemonWorkspace } = await import('@/lib/daemon-workspaces')
  const { workspacePathsMatch } = await import('@/stores/session-utils')

  if (app.workspaceId) {
    try {
      const [row] = await getBackend().workspaces.listWorkspacesByIds(ctx.teamId, [app.workspaceId])
      if (row?.path && workspacePathsMatch(row.path, appWorkdir)) return app.workspaceId
      // Keep the row's existing name: `workspaces` is unique on
      // (team_id, agent_id, name), and renaming it to the app's name here
      // could collide with a workspace the user already has.
      const saved = await createDaemonWorkspace({
        id: app.workspaceId,
        teamId: ctx.teamId,
        // Bound to this machine's daemon, like every other workspace row.
        // Opening the same app on a second machine re-points the row at that
        // machine's daemon and its own copy of the checkout — whoever opened
        // the app last owns the row, and the other machine takes it back the
        // next time the app is opened there. Nothing is lost either way: the
        // path is derived from the app, so each machine keeps its own copy at
        // the same relative place under its own amuxd home.
        agentId: ctx.localDaemonActorId,
        createdByMemberId: ctx.creatorActorId,
        name: row?.name || app.name,
        path: appWorkdir,
      })
      return saved.id
    } catch (e) {
      console.warn('[app-session] could not fill in the app workspace path:', e)
    }
  }

  try {
    const existing = (await listDaemonWorkspaces(ctx.teamId, ctx.localDaemonActorId)).find(
      (w) => !w.archived && w.path && workspacePathsMatch(w.path, appWorkdir),
    )
    if (existing) return existing.id
    const created = await createDaemonWorkspace({
      teamId: ctx.teamId,
      agentId: ctx.localDaemonActorId,
      createdByMemberId: ctx.creatorActorId,
      name: app.name,
      path: appWorkdir,
    })
    return created.id
  } catch (e) {
    console.warn('[app-session] could not register app daemon workspace (non-fatal):', e)
    return null
  }
}

/**
 * Record where the daemon put an app's files, without needing a session.
 *
 * Called the moment the seed (or clone) reports back, so the app's workspace
 * carries its path from creation onward — the session-open path used to be the
 * first and only chance to write it, which left a window where runtime-start
 * had nothing to resolve but the desktop's current workspace.
 */
export async function bindAppWorkdir(app: AppRow, workdir: string): Promise<string | null> {
  const trimmed = workdir.trim()
  if (!trimmed) return null
  try {
    const ctx = await loadContext(app)
    return await ensureAppWorkspaceRow(app, trimmed, ctx)
  } catch (e) {
    console.warn('[app-session] could not record the app workdir (non-fatal):', e)
    return null
  }
}

/**
 * Point a session at the app's checkout, both locally and in the cloud.
 *
 * Two bindings, because two different things read them: the local libsql row
 * drives the desktop UI (file browser, workspace switch), and the cloud
 * workspace row is what runtime-start resolves to a path — without a path there
 * the daemon falls back to the desktop's current workspace and the agent runs
 * in the wrong directory.
 *
 * Returns the app's cloud workspace id, so the caller can hand it to
 * runtime-start directly instead of letting it be inferred.
 */
async function bindAppWorkspace(
  app: AppRow,
  sessionId: string,
  ctx: AppSessionContext,
): Promise<string | null> {
  const appWorkdir = await appWorkdirPath(app.id, app.teamId || ctx.teamId)
  if (!appWorkdir || !ctx.localDaemonActorId) return app.workspaceId ?? null

  const workspaceId = await ensureAppWorkspaceRow(app, appWorkdir, ctx)

  if (ctx.viewerMemberId) {
    try {
      await upsertSessionWorkspacesBatch([
        {
          sessionId,
          teamId: ctx.teamId,
          viewerMemberId: ctx.viewerMemberId,
          agentId: ctx.localDaemonActorId,
          workspaceId: workspaceId ?? app.workspaceId ?? null,
          workspacePath: appWorkdir,
          updatedAt: new Date().toISOString(),
        },
      ])
    } catch (e) {
      console.warn('[app-session] could not bind session workspace (non-fatal):', e)
    }
  }

  return workspaceId ?? app.workspaceId ?? null
}

async function seatDaemonAndBind(
  app: AppRow,
  sessionId: string,
  ctx: AppSessionContext,
): Promise<void> {
  if (ctx.localDaemonActorId) {
    try {
      await getBackend().sessionMembers.addParticipant(sessionId, ctx.localDaemonActorId)
    } catch (e) {
      console.warn('[app-session] could not seat the local daemon (non-fatal):', e)
    }
  }
  await bindAppWorkspace(app, sessionId, ctx)
}

/**
 * Open an existing app session: seat the daemon and bind the checkout.
 */
export async function openAppSession(app: AppRow, sessionId: string): Promise<void> {
  const ctx = await loadContext(app)
  const { ensureAppCheckout } = await import('@/stores/apps-store')
  await ensureAppCheckout(app)
  await seatDaemonAndBind(app, sessionId, ctx)
}

/**
 * The app's most recent session, if one exists. Never creates a session.
 *
 * The local daemon is seated when a session is found — the cloud API serves
 * `GET /v1/sessions/:id` through participant-scoped RLS, so a daemon with no
 * seat cannot read the session it is asked to run.
 */
export async function ensureAppSession(app: AppRow): Promise<string | null> {
  const ctx = await loadContext(app)

  const { ensureAppCheckout } = await import('@/stores/apps-store')
  await ensureAppCheckout(app)

  const sessions = await getBackend().apps.listAppSessions(app.id)
  const recent = pickMostRecentSession(sessions)
  if (!recent) return null

  await seatDaemonAndBind(app, recent.id, ctx)
  return recent.id
}

/**
 * Create an empty session linked to the app (no opening message).
 */
export async function createAppSessionShell(app: AppRow): Promise<string | null> {
  const ctx = await loadContext(app)
  if (!ctx.creatorActorId) {
    console.error('[app-session] cannot create a session: no current actor')
    return null
  }

  const { ensureAppCheckout } = await import('@/stores/apps-store')
  await ensureAppCheckout(app)

  const { sessionId } = await createSessionShell({
    teamId: ctx.teamId,
    creatorActorId: ctx.creatorActorId,
    title: app.name,
    additionalActorIds: ctx.localDaemonActorId ? [ctx.localDaemonActorId] : [],
    appId: app.id,
  })
  await seatDaemonAndBind(app, sessionId, ctx)
  return sessionId
}

/**
 * Open a brand-new app: create its session with the opening message already
 * sent, so the agent is working by the time the user looks at it.
 *
 * The message @-mentions the local daemon on purpose. An unmentioned message
 * is only silent-queued by the daemon, so without it the agent would sit idle
 * until the user typed something — which defeats the point of sending an
 * opening message at all.
 */
export async function startAppFirstSession(app: AppRow): Promise<string | null> {
  const ctx = await loadContext(app)
  if (!ctx.creatorActorId) {
    console.error('[app-session] cannot start the first session: no current actor')
    return null
  }
  const agentIds = ctx.localDaemonActorId ? [ctx.localDaemonActorId] : []

  const { sessionId } = await createSessionWithFirstMessage({
    teamId: ctx.teamId,
    creatorActorId: ctx.creatorActorId,
    additionalActorIds: agentIds,
    agentActorIds: agentIds,
    messageText: firstPromptForApp(app),
    title: app.name,
    appId: app.id,
    mentionActorIds: agentIds,
  })

  // Bind before starting the runtime: runtime-start resolves the session's
  // workspace, and an unbound session lands the agent in the default folder.
  const workspaceId = await bindAppWorkspace(app, sessionId, ctx)

  if (agentIds.length > 0) {
    const { startAgentRuntimesAsync } = await import('@/lib/session-create')
    void startAgentRuntimesAsync({
      sessionId,
      teamId: ctx.teamId,
      agentActorIds: agentIds,
      // Name the app's workspace outright. This is the session's first runtime,
      // so there is no prior `agent_runtimes.workspace_id` to resolve from, and
      // without a hint the fallback chain ends at the desktop's currently open
      // workspace — the first thing the agent wrote then landed there.
      workspaceIdHint: workspaceId,
    }).catch((e) => console.warn('[app-session] runtime start failed (non-fatal):', e))
  }
  return sessionId
}
