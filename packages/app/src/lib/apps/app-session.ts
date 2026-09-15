/**
 * Sessions linked to an app.
 *
 * An app may have many sessions; the user creates each one explicitly except
 * the first session opened by {@link startAppFirstSession} during app creation.
 * {@link ensureAppSession} reopens the most recent existing session only —
 * it never creates one. Use {@link createAppSessionShell} for an empty session.
 */
import { getBackend } from '@/lib/backend'
import {
  createSessionShell,
  createSessionWithFirstMessage,
  type LocalDaemonWorkspaceBinding,
} from '@/lib/session/session-create'
import { invalidateViewerWorkspaceContext } from '@/lib/session/session-viewer-workspace'
import { resolveCurrentMemberActorId } from '@/lib/actor/current-actor'
import { upsertSessionWorkspacesBatch } from '@/lib/cache/local-cache'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useAuthStore } from '@/stores/auth-store'
import { isTauri } from '@/lib/utils'
import { resolveAppType } from '@/lib/apps/app-types'
import { recordAppSessionSetup, runAppSessionSetupOnce } from '@/lib/apps/app-session-setup'
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
async function appWorkdirPath(
  appId: string,
  teamId?: string | null,
): Promise<string | null> {
  if (!isTauri()) return null
  const { daemonAppWorkdir } = await import('@/lib/daemon/daemon-local-client')
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
 * A templated app is pointed at `AGENTS.md` first — that file is where the
 * template records the build contract it must not break — and asked for a plan
 * before edits, so the first thing the user sees is a proposal rather than a
 * pile of files.
 *
 * An imported one has no template and therefore no `AGENTS.md`, so it is asked
 * to read what is already there and then ask what the user wants done with it.
 */
export function firstPromptForApp(app: Pick<AppRow, 'name' | 'type'>): string {
  const name = app.name.trim()
  switch (resolveAppType(app.type).id) {
    // Deliberately silent about AGENTS.md: that file comes from a starter
    // template, and an imported repo — or a folder someone pointed us at — has
    // none. The code itself is the brief here, and what to do with it is the
    // user's to say, not ours to assume.
    case 'imported':
      return `这是一个已有的项目：${name}\n\n先把代码读一遍，弄清楚它是做什么的、怎么组织的，然后把你的理解讲给我听，并问我下一步的计划。`
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
  const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
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

/** A workspace row standing for this machine's checkout of an app. */
interface AppWorkspaceRow {
  id: string
  /**
   * The local daemon's seat can take this row: it is that daemon's own and not
   * archived, which is what the Cloud API holds a seat's workspace to. False
   * when that is not known — an older Cloud API does not say who holds a row —
   * which costs the seat binding, never the session.
   */
  seatable: boolean
}

/**
 * The workspace row that stands for THIS machine's copy of the app, creating
 * or filling it in as needed.
 *
 * An app is created with a 1:1 workspace (`apps.workspace_id`), and the cloud
 * API — which never sees a filesystem — creates it with a name and no path. A
 * path-less workspace is one the daemon cannot resolve: `apply_start_runtime`
 * falls through to whatever `worktree` the desktop sent, and when the desktop
 * had nothing to send it used the *currently open* workspace. That is how an
 * app's files ended up in whatever folder the user happened to have open.
 * Filling that row in is what makes the app directory resolvable on its own,
 * from any of the four routes runtime-start tries, and on a device whose local
 * cache is cold.
 *
 * But a workspace row is machine-scoped and an app row is not. `workspaces` is
 * unique on `(team_id, agent_id, name)` and carries one absolute `path`, while
 * the daemon's `agent_id` is per-install (`~/.amuxd/backend.toml`) — so the
 * same account signed in on two computers has two daemons, two checkouts and
 * two paths, against a single `apps.workspace_id`. This used to overwrite that
 * one row with whichever machine opened the app last, which re-pointed the
 * other machine's sessions at a directory it does not have.
 *
 * So the app's own row is claimed only when it is unclaimed (no path yet) or
 * already names this machine's directory. Anything else means another machine
 * holds it, and this machine gets a row of its own — found by path, or created.
 * `POST /v1/workspaces` dedupes on `(team, path)` before `(team, agent, name)`
 * and renames on a name collision, so creating one is safe.
 *
 * Two machines that lay their home out identically share the app's row, held by
 * whichever claimed it first. It resolves correctly on both, but only the
 * holder's daemon can put it on its seat — hence {@link AppWorkspaceRow.seatable}.
 */
async function ensureAppWorkspaceRow(
  app: AppRow,
  appWorkdir: string,
  ctx: AppSessionContext,
): Promise<AppWorkspaceRow | null> {
  const localDaemonActorId = ctx.localDaemonActorId
  if (!localDaemonActorId) return null
  const { listDaemonWorkspaces, createDaemonWorkspace } = await import('@/lib/daemon/daemon-workspaces')
  const { workspacePathsMatch } = await import('@/stores/session-utils')
  const seatable = (row: { agentId?: string | null; archived?: boolean }) =>
    row.agentId === localDaemonActorId && row.archived !== true

  if (app.workspaceId) {
    try {
      const [row] = await getBackend().workspaces.listWorkspacesByIds(ctx.teamId, [app.workspaceId])
      // Already this directory — either this machine claimed it, or both
      // machines happen to lay their amuxd home out identically, in which case
      // the path resolves correctly on each and one row is enough.
      if (row?.path && workspacePathsMatch(row.path, appWorkdir)) {
        return { id: app.workspaceId, seatable: seatable(row) }
      }
      if (row && !row.path) {
        // Unclaimed: the row the cloud API minted with the app, which no
        // machine has bound to a directory yet. Keep its existing name —
        // `workspaces` is unique on (team_id, agent_id, name) and renaming it
        // to the app's name here could collide with one the user already has.
        const saved = await createDaemonWorkspace({
          id: app.workspaceId,
          teamId: ctx.teamId,
          agentId: localDaemonActorId,
          createdByMemberId: ctx.creatorActorId,
          name: row.name || app.name,
          path: appWorkdir,
        })
        return { id: saved.id, seatable: seatable(saved) }
      }
      // A row with a *different* path belongs to another machine's copy of this
      // app. Leave it exactly as it is and fall through to this machine's own.
    } catch (e) {
      console.warn('[app-session] could not read the app workspace row:', e)
    }
  }

  try {
    const existing = (await listDaemonWorkspaces(ctx.teamId, localDaemonActorId)).find(
      (w) => !w.archived && w.path && workspacePathsMatch(w.path, appWorkdir),
    )
    if (existing) return { id: existing.id, seatable: seatable(existing) }
    const created = await createDaemonWorkspace({
      teamId: ctx.teamId,
      agentId: localDaemonActorId,
      createdByMemberId: ctx.creatorActorId,
      name: app.name,
      path: appWorkdir,
    })
    return { id: created.id, seatable: seatable(created) }
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
    return (await ensureAppWorkspaceRow(app, trimmed, ctx))?.id ?? null
  } catch (e) {
    console.warn('[app-session] could not record the app workdir (non-fatal):', e)
    return null
  }
}

/** This machine's checkout of an app, as far as it could be pinned down. */
interface AppCheckout {
  workdir: string
  /**
   * This machine's cloud workspace id for the checkout. Null when it could not
   * be established — `apps.workspace_id` is deliberately NOT used as a
   * fallback, because on a second machine that row names another computer's
   * directory, and a wrong path is worse than none: runtime-start falls back to
   * the worktree it was given, while a wrong workspace resolves to a directory
   * that is not here.
   */
  workspaceId: string | null
  /** `workspaceId`, when the local daemon's seat can take it; see {@link AppWorkspaceRow}. */
  seatWorkspaceId: string | null
}

/** Find the app's checkout on this machine and the workspace row that stands for it. */
async function resolveAppCheckout(
  app: AppRow,
  ctx: AppSessionContext,
  /** The checkout directory when the caller already has it, so the daemon is not asked twice. */
  knownWorkdir?: string | null,
): Promise<AppCheckout | null> {
  if (!ctx.localDaemonActorId) return null
  const workdir =
    knownWorkdir ??
    (await appWorkdirPath(app.id, app.teamId || ctx.teamId).catch((e) => {
      console.warn('[app-session] could not ask the daemon where the checkout is (non-fatal):', e)
      return null
    }))
  // No directory from the daemon means nothing to bind. `apps.workspace_id` is
  // not a stand-in for it: see the note on `AppCheckout.workspaceId`.
  if (!workdir) return null
  const row = await ensureAppWorkspaceRow(app, workdir, ctx)
  return {
    workdir,
    workspaceId: row?.id ?? null,
    seatWorkspaceId: row?.seatable ? row.id : null,
  }
}

/**
 * The `localWorkspace` an app session is created with, so the local daemon's
 * seat starts out on the checkout rather than on the agent's default folder.
 */
function seatBindingFor(
  checkout: AppCheckout | null,
  ctx: AppSessionContext,
): LocalDaemonWorkspaceBinding | null {
  if (!checkout?.seatWorkspaceId || !ctx.localDaemonActorId) return null
  return {
    agentId: ctx.localDaemonActorId,
    workspaceId: checkout.seatWorkspaceId,
    path: checkout.workdir,
  }
}

/**
 * Point a session at the app's checkout: the local daemon's seat, and this
 * viewer's local binding.
 *
 * The seat (`session_participants.workspace_id`) is the binding that counts.
 * The file tree, runtime-start and the daemon's cold paths all read the agent's
 * folder from it (ADR-0005), and a seat created without a workspace named gets
 * the agent's *default* folder. Only the local binding used to be written here,
 * and the viewer resolver reads that only for a seat with no workspace at all —
 * so an app session showed the default workspace while its agent, started by
 * the outbox fast path from the local binding, worked in the checkout (#1430).
 *
 * True when both landed, or when the seat cannot take this machine's row (see
 * {@link AppWorkspaceRow}) — retrying would not change that. Anything else is
 * worth retrying on the next open.
 */
async function bindAppWorkspace(
  sessionId: string,
  ctx: AppSessionContext,
  checkout: AppCheckout | null,
  /** The session was created with its seat already on the checkout. */
  seatAlreadyBound = false,
): Promise<boolean> {
  const localDaemonActorId = ctx.localDaemonActorId
  if (!checkout || !localDaemonActorId) return false

  if (ctx.viewerMemberId) {
    try {
      await upsertSessionWorkspacesBatch([
        {
          sessionId,
          teamId: ctx.teamId,
          viewerMemberId: ctx.viewerMemberId,
          agentId: localDaemonActorId,
          workspaceId: checkout.workspaceId,
          workspacePath: checkout.workdir,
          updatedAt: new Date().toISOString(),
        },
      ])
    } catch (e) {
      console.warn('[app-session] could not bind session workspace (non-fatal):', e)
    }
  }

  let seatBound = true
  if (!seatAlreadyBound && checkout.seatWorkspaceId) {
    try {
      await getBackend().sessionMembers.setParticipantWorkspace(
        sessionId,
        localDaemonActorId,
        checkout.seatWorkspaceId,
      )
    } catch (e) {
      seatBound = false
      console.warn('[app-session] could not move the daemon seat onto the checkout (non-fatal):', e)
    }
  }
  // The viewer resolver keeps this machine's workspace list for a few seconds,
  // and the checkout's row may be newer than that.
  invalidateViewerWorkspaceContext(ctx.teamId)

  return checkout.workspaceId !== null && seatBound
}

/**
 * Seat the local daemon in the session and bind the session to the checkout.
 *
 * True only when both landed. Anything less — no daemon, a failed seat, no
 * directory — is worth retrying on the next open, so it must not count as done.
 */
async function seatDaemonAndBind(
  sessionId: string,
  ctx: AppSessionContext,
  checkout: AppCheckout | null,
  seatAlreadyBound = false,
): Promise<boolean> {
  let seated = false
  if (ctx.localDaemonActorId) {
    try {
      await getBackend().sessionMembers.addParticipant(sessionId, ctx.localDaemonActorId)
      seated = true
    } catch (e) {
      console.warn('[app-session] could not seat the local daemon (non-fatal):', e)
    }
  }
  // After the seat: moving it needs the row to exist.
  const bound = await bindAppWorkspace(sessionId, ctx, checkout, seatAlreadyBound)
  return seated && bound
}

/**
 * Open an existing app session: seat the daemon and bind the checkout —
 * including moving a seat that was created on the agent's default folder.
 *
 * Once per session per launch — both halves are idempotent, and the session
 * list calls this on every switch. Callers need not await it before showing the
 * session: a runtime start for it waits on the setup in flight (see
 * `app-session-setup`).
 */
export function openAppSession(app: AppRow, sessionId: string): Promise<void> {
  return runAppSessionSetupOnce(app.id, sessionId, async () => {
    // Independent: one asks who we are, the other makes sure the code is here.
    const [ctx, workdir] = await Promise.all([
      loadContext(app),
      import('@/stores/apps-store').then(({ ensureAppCheckout }) => ensureAppCheckout(app)),
    ])
    return seatDaemonAndBind(sessionId, ctx, await resolveAppCheckout(app, ctx, workdir))
  })
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
  const workdir = await ensureAppCheckout(app)

  const sessions = await getBackend().apps.listAppSessions(app.id)
  const recent = pickMostRecentSession(sessions)
  if (!recent) return null

  await seatDaemonAndBind(recent.id, ctx, await resolveAppCheckout(app, ctx, workdir))
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
  // Before the session exists, so its daemon seat is created on the checkout
  // instead of on the agent's default folder and then moved.
  const checkout = await resolveAppCheckout(app, ctx, await ensureAppCheckout(app))
  const localWorkspace = seatBindingFor(checkout, ctx)

  const { sessionId } = await createSessionShell({
    teamId: ctx.teamId,
    creatorActorId: ctx.creatorActorId,
    title: app.name,
    additionalActorIds: ctx.localDaemonActorId ? [ctx.localDaemonActorId] : [],
    appId: app.id,
    localWorkspace,
  })
  // Recorded here so the first switch to the new session does not repeat it.
  if (await seatDaemonAndBind(sessionId, ctx, checkout, localWorkspace !== null)) {
    recordAppSessionSetup(app.id, sessionId)
  }
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

  // Before the session exists, so its daemon seat is created on the checkout.
  // runtime-start resolves the seat, and a seat created without a workspace
  // named gets the agent's default folder — the agent would start there.
  const checkout = await resolveAppCheckout(app, ctx)
  const localWorkspace = seatBindingFor(checkout, ctx)

  const { sessionId } = await createSessionWithFirstMessage({
    teamId: ctx.teamId,
    creatorActorId: ctx.creatorActorId,
    additionalActorIds: agentIds,
    agentActorIds: agentIds,
    messageText: firstPromptForApp(app),
    title: app.name,
    appId: app.id,
    mentionActorIds: agentIds,
    localWorkspace,
  })

  // Before starting the runtime, which the outbox fast path does from the
  // local binding this writes.
  await bindAppWorkspace(sessionId, ctx, checkout, localWorkspace !== null)

  if (agentIds.length > 0) {
    const { startAgentRuntimesAsync } = await import('@/lib/session/session-create')
    void startAgentRuntimesAsync({
      sessionId,
      teamId: ctx.teamId,
      agentActorIds: agentIds,
      // The seat decides where the runtime starts; this is only checked against
      // it, and a mismatch is logged — which is how a seat that could not take
      // this machine's row shows up.
      workspaceIdHint: checkout?.workspaceId ?? null,
    }).catch((e) => console.warn('[app-session] runtime start failed (non-fatal):', e))
  }
  return sessionId
}
