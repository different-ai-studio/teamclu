import { create } from 'zustand'
import i18n from '@/lib/i18n'
import { isTauri } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import {
  probeDaemonHttp,
  invalidateDaemonConnection,
  fetchDaemonCloudAuthStatus,
} from '@/lib/daemon/daemon-local-client'
import { useSetupStore } from '@/stores/setup'
import { markStartup } from '@/lib/telemetry/startup-perf'
import { appScheme } from '@/lib/config/build-config'
import {
  clearDaemonOnboardingIdentity,
  readDaemonOnboardingIdentity,
  writeDaemonOnboardingIdentity,
} from '@/lib/daemon/daemon-onboarding-identity'
import { daemonManagedLogDisplayPath } from '@/lib/daemon/daemon-paths'
import { useAuthStore } from '@/stores/auth-store'

/**
 * Make this machine's agent the member's default — only for an enable that ran
 * because the team offered no default at all (#1678).
 *
 * Binding no longer writes the member default by itself. Enabling for a feature,
 * from the sidebar, or rebinding after a team switch leaves whatever default the
 * member chose alone; only "nothing to talk to otherwise" earns a write.
 *
 * Best-effort: failures here must not fail the enable.
 */
async function adoptDeviceAgentAsDefault(teamId: string): Promise<void> {
  try {
    const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
    const agentId = await getLocalDaemonActorId()
    if (!agentId) return
    const prefs = useMemberPreferencesStore.getState()
    await prefs.ensureLoaded(teamId)
    if (useMemberPreferencesStore.getState().defaultAgentId !== agentId) {
      await useMemberPreferencesStore.getState().setDefaultAgent(teamId, agentId)
    }
    void useMemberPreferencesStore.getState().loadEffectiveDefaultAgent(teamId)
  } catch (e) {
    console.warn('[daemon-onboarding] could not set local daemon as default agent', e)
  }
}

/**
 * Is the local Agent switched on for this machine? The Rust side's switch is
 * authoritative — it refuses to start amuxd while off — so anything but an
 * explicit `false` (an older host without the command, say) reads as on, the
 * behaviour before the switch existed.
 */
async function readLocalAgentEnabled(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return (await invoke<boolean>('local_agent_enabled')) !== false
  } catch (e) {
    console.warn('[daemon-onboarding] local_agent_enabled failed; assuming enabled', e)
    return true
  }
}

/**
 * The enable currently in progress, if any.
 *
 * `adopt`: write the local agent as the member default once ready (the
 * no-default-anywhere path only). `rollback`: the machine was off before this
 * run, so a failure switches it back off — otherwise a failed enable would keep
 * amuxd starting on every launch, and a team switch to a team that does have a
 * default would still be blocked on it.
 */
type EnableRun = { teamId: string | null; adopt: boolean; rollback: boolean }
let enableRun: EnableRun | null = null

/**
 * Is any required row of the managed runtime missing, as the daemon's doctor
 * last reported it? `amuxd` itself is excluded: it is the bundled sidecar this
 * very flow is talking to.
 */
function runtimeMissing(): boolean {
  return useSetupStore
    .getState()
    .requirements.some((r) => !r.optional && r.id !== 'amuxd' && !r.present)
}

/**
 * The daemon that answered `amuxd doctor` is older than this app and does not
 * report the managed runtime's rows at all.
 *
 * Worth a message of its own because every other reading of this state is a
 * lie: the rows come back `present: false`, the install "succeeds" (there is
 * nothing for it to do), the re-check still says missing, and the wizard ends
 * on "the runtime was installed but does not report as ready" — pointing at a
 * runtime that was fine and a log that says nothing about it.
 *
 * Reachable in a dev checkout, where `scripts/ensure-amuxd-sidecar.js` stages
 * the sidecar once at `pnpm tauri:dev` launch while the Rust host is rebuilt on
 * every source change. A shipped bundle always carries a matching pair.
 */
function staleDaemonMessage(): string | null {
  const row = useSetupStore.getState().requirements.find((r) => r.blocker === 'daemon_outdated')
  if (!row) return null
  return row.blockerFound && row.blockerRequired
    ? i18n.t(
        'settings.daemonOnboarding.daemonOutdated',
        'The local daemon (amuxd {{found}}) is older than this app ({{required}}) and cannot report whether the runtime is ready. Reinstall the app — or, in a dev checkout, restart `pnpm tauri:dev` so the bundled daemon is rebuilt.',
        { found: row.blockerFound, required: row.blockerRequired },
      )
    : i18n.t(
        'settings.daemonOnboarding.daemonOutdatedUnknownVersion',
        'The local daemon is older than this app and cannot report whether the runtime is ready. Reinstall the app — or, in a dev checkout, restart `pnpm tauri:dev` so the bundled daemon is rebuilt.',
      )
}

/**
 * Make sure the managed runtime (Node.js + pi + the MCP SDK) is installed
 * before the gate opens onto the chat UI (#1250).
 *
 * Cheap when it is: one `amuxd doctor` through the setup store, no install.
 * When something is missing — a first run, or a machine upgraded from a build
 * that ran another runtime — this flips the wizard to 'starting', runs
 * `amuxd install-pi` under the `install-runtime` step (its progress lines show
 * beneath the step), and re-checks. Returns false after putting the store in
 * the error state, so callers just return.
 *
 * Runs after the daemon is bound and up rather than before, so a brand-new
 * machine is asked for its agent's name first and downloads while the user
 * is not waiting on a prompt.
 */
async function ensureRuntimeReady(): Promise<boolean> {
  const setup = useSetupStore.getState()
  await setup.listRequirements()
  if (!useSetupStore.getState().loaded || !runtimeMissing()) return true

  if (useDaemonOnboardingStore.getState().runStartedAt === null) beginRun()
  useDaemonOnboardingStore.setState({ status: 'starting', loaded: true, busy: true, error: null })
  try {
    await runStep('install-runtime', async () => {
      // Before the install, not after: on a stale daemon it would download
      // nothing, report success, and leave the rows exactly as they are.
      const stale = staleDaemonMessage()
      if (stale) {
        useDaemonOnboardingStore.setState({ daemonOutdated: true })
        throw new Error(stale)
      }
      await useSetupStore.getState().install('pi')
      const failure = useSetupStore.getState().errors.pi
      if (failure) throw new Error(failure)
      await useSetupStore.getState().listRequirements()
      if (runtimeMissing()) {
        throw new Error(
          i18n.t('settings.daemonOnboarding.runtimeStillMissing', {
            path: daemonManagedLogDisplayPath,
            defaultValue:
              'The runtime was installed but still does not report as ready. See {{path}}.',
          }),
        )
      }
    })
    return true
  } catch (e) {
    useDaemonOnboardingStore.setState({
      status: 'error',
      loaded: true,
      error: e instanceof Error ? e.message : String(e),
    })
    return false
  } finally {
    useDaemonOnboardingStore.setState({ busy: false })
  }
}

// 'disabled'       — local Agent is off and the team has a default to talk to
// 'defaults-error' — local Agent is off and the defaults could not be read;
//                    blocks with a retry, never read as "no default"
// 'unknown'        — no current team yet (don't block)
// 'needs-onboard'  — daemon bound to no team -> bind silently
// 'mismatch'       — daemon bound to a different team -> re-bind silently
// 'starting'       — binding, or bound to this team but daemon down/token-stale
// 'ready'          — bound to this team, running, token valid
// 'error'          — binding or auto-recovery failed -> show retry
//
// 'needs-onboard' and 'mismatch' are no longer screens. They are the two inputs
// that make `refresh` bind this machine's agent, and the user sees 'starting'
// while it happens. They stay in the type because they are still the honest
// description of what the daemon's config says.
type OnboardingStatus =
  | 'unknown'
  | 'disabled'
  | 'defaults-error'
  | 'needs-onboard'
  | 'mismatch'
  | 'starting'
  | 'ready'
  | 'error'

/**
 * The distinct operations hiding behind `status === 'starting'` (#881).
 *
 * That one status used to cover five separate things — binding the machine's
 * agent, writing credentials, restarting the daemon, waiting for its HTTP port,
 * and checking cloud auth — behind a single spinner, so a wedged step looked
 * exactly like a fast one and a failure could only say "couldn't start".
 *
 * Silent binding raises the stakes rather than lowering them: nobody clicked
 * anything, so this trail is the only account of what the machine is doing.
 */
export type OnboardingStep =
  | 'start-daemon'
  | 'install-runtime'
  | 'mint-invite'
  | 'init-daemon'
  | 'restart-daemon'
  | 'await-daemon'
  | 'cloud-auth'
  | 'register-workspace'

/** Ordered for display; `register-workspace` is best-effort and not shown. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  'start-daemon',
  'install-runtime',
  'mint-invite',
  'init-daemon',
  'restart-daemon',
  'await-daemon',
  'cloud-auth',
]

/** Pure status from daemon-bound teamId vs the logged-in current teamId. */
export function computeOnboardingStatus(
  daemonTeamId: string | null,
  currentTeamId: string | null,
): OnboardingStatus {
  if (!currentTeamId) return 'unknown'
  if (!daemonTeamId) return 'needs-onboard'
  return daemonTeamId === currentTeamId ? 'ready' : 'mismatch'
}

type DaemonOnboardingState = {
  status: OnboardingStatus
  /** The local Agent switch (#1678). Null until the first `refresh` reads it. */
  enabled: boolean | null
  /** The last failed run was an enable; Retry should enable again rather than
   * just refresh (which, with the machine switched back off, would do nothing). */
  retryEnable: { adopt: boolean } | null
  loaded: boolean
  busy: boolean
  error: string | null
  /** The local daemon's cloud session was terminally rejected (refresh token
   * dead). Drives the "reconnecting" banner; the daemon can't advertise its
   * backends or sync until re-onboarded. */
  cloudAuthExpired: boolean
  /** An auto re-onboard is in flight (mint re-invite → amuxd init → restart). */
  healing: boolean
  /** Last auto-heal failure (e.g. caller doesn't own the agent). Non-null
   * suppresses further automatic attempts; the banner offers a manual retry. */
  healError: string | null
  /** Operation currently running, or null when nothing is in flight. */
  step: OnboardingStep | null
  /** Steps finished during this run, in the order they completed. */
  completedSteps: OnboardingStep[]
  /** Which step owns `error`. Lets the failure screen name it and offer the
   * recovery that actually fits, instead of a bare Retry. */
  failedStep: OnboardingStep | null
  /** `install-runtime` failed because the daemon is too old to report the
   * runtime, not because a download broke. Kept apart from `failedStep`
   * because the two want opposite advice: the step's own recovery copy sends
   * the user at their network, which here is the one thing that is fine. */
  daemonOutdated: boolean
  /** Epoch ms the current run began. The store keeps only the timestamp — a
   * ticking counter here would re-render every subscriber once a second. */
  runStartedAt: number | null
  /** Set when the user named this machine's agent, so the naming screen can
   * confirm what happened instead of just vanishing. Only the create path fills
   * it: a silent rebind has no screen to report back to. */
  completedAgent: { agentId: string; displayName: string } | null
  /**
   * Set when this machine has no agent in the current team yet, i.e. the one case
   * that still asks the user something: name your new robot. Binding waits for
   * `nameDeviceAgent`, because the name can only be applied at creation.
   *
   * Null at every other moment, including every rebind — that path is silent.
   */
  pendingName: { teamId: string; deviceId: string; suggested: string } | null
  /**
   * Bumped after the default workspace is registered for this machine's agent.
   * LocalDaemonRow listens and reloads so the panel does not stay empty until
   * a later incidental refresh.
   */
  /** Create this machine's agent under `name` and finish binding. */
  nameDeviceAgent: (name: string) => Promise<void>
  /** `forceIdentityRebind` re-binds even when the daemon already points at the
   * current team — used after a linked-account switch, where the team is the same
   * but the authority behind the daemon's credentials is not. A team *change*
   * needs no flag: a mismatch always re-binds now. */
  refresh: (opts?: { forceIdentityRebind?: boolean; fresh?: boolean }) => Promise<void>
  /**
   * Switch the local Agent on and run the whole setup: start amuxd, bind this
   * machine's agent in the current team, install the runtime. `adoptAsDefault`
   * writes the agent as the member default once ready — pass it only when the
   * team had no default at all.
   */
  enable: (opts?: { adoptAsDefault?: boolean }) => Promise<void>
  /** Read the switch without running a refresh (for consumers that only need
   * to know, before any refresh has run). */
  loadEnabled: () => Promise<boolean>
  /** Switch the local Agent off: stop amuxd, clear the member default when it
   * pointed here. Callers confirm a team default pointing here first. */
  disable: () => Promise<void>
  /** Retry after a failure: re-runs an enable that failed, else refreshes. */
  retry: () => Promise<void>
  /** Wipe local daemon state. Settings-only (DaemonManualResetCard); the next
   * `refresh` re-binds this machine silently. */
  forceReset: () => Promise<void>
  /** Poll the daemon's cloud-auth health; auto-heal once when terminally expired. */
  checkCloudSession: (opts?: { allowRetryAfterHealError?: boolean }) => Promise<void>
  /** Re-onboard the local daemon in place (same actor) to restore credentials. */
  autoHealCloudSession: () => Promise<void>
}

async function daemonTeamId(): Promise<string | null> {
  if (!isTauri()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return (await invoke<string | null>('get_daemon_team_id')) ?? null
}

function currentAuthUserId(): string | null {
  return useAuthStore.getState().session?.user?.id ?? null
}

function rememberDaemonIdentity(teamId: string): void {
  const userId = currentAuthUserId()
  if (userId) writeDaemonOnboardingIdentity({ teamId, userId })
}

/** Start a fresh run: clear the previous run's step trail and failure. */
function beginRun(): void {
  useDaemonOnboardingStore.setState({
    step: null,
    completedSteps: [],
    failedStep: null,
    daemonOutdated: false,
    runStartedAt: Date.now(),
  })
}

/**
 * Mark `step` active, run `fn`, record it as done.
 *
 * On failure it records `failedStep` and rethrows unchanged, so every existing
 * catch block keeps behaving exactly as it did.
 */
async function runStep<T>(step: OnboardingStep, fn: () => Promise<T>): Promise<T> {
  useDaemonOnboardingStore.setState({ step })
  try {
    const result = await fn()
    useDaemonOnboardingStore.setState((s) => ({
      completedSteps: s.completedSteps.includes(step) ? s.completedSteps : [...s.completedSteps, step],
      step: null,
    }))
    return result
  } catch (e) {
    useDaemonOnboardingStore.setState({ failedStep: step, step: null })
    throw e
  }
}

/**
 * The local agent's default display name: the signed-in member's own name with
 * a `Bot` suffix, no separator — 「周金亮Bot」.
 *
 * It used to be the machine's hostname, which is whatever the OS happens to
 * call the box. `zhoujinliangs-Mac-mini-3` says nothing about whose agent it
 * is, and this name is what everyone reads in the actor list.
 *
 * The hostname stays as the fallback: `currentMember` can still be null the
 * first time this runs, and an agent with an empty name is rejected outright.
 */
async function deviceDisplayName(): Promise<string> {
  const member = useCurrentTeamStore.getState().currentMember?.displayName?.trim()
  if (member) return `${member}Bot`
  const { invoke } = await import('@tauri-apps/api/core')
  const host = (await invoke<string>('get_device_hostname'))?.trim()
  // A nameless machine would create an agent called "" — the server rejects that,
  // so fall back to something a human can still recognize in the actor list.
  return host || 'Local daemon'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Same budget as `ensureHealthy`'s poll — 6s after the spawn attempt returns. */
const DEVICE_ID_POLL_ATTEMPTS = 12
const DEVICE_ID_POLL_MS = 500

/**
 * This machine's id, as the daemon reports it. Throws rather than inventing one.
 *
 * Binding is the one path that runs *before* the daemon is known to be up:
 * `refresh` only auto-recovers a daemon already bound to this team, so a fresh
 * machine reached `/v1/info` with nothing having started amuxd yet. Asking once
 * and failing made that a race every first launch could lose — and the loudest
 * way to lose it is a brand or layout change that moves the daemon home, since
 * the daemon's first boot in an empty home does real work (bootstrap config,
 * runtime discovery) before it binds its port. Start it and wait here.
 *
 * Under a named step, so a genuine failure names the thing that broke instead
 * of surfacing as a bare "can't read this machine's id" with no step at all.
 */
async function requireDeviceId(): Promise<string> {
  const { fetchDaemonDeviceId } = await import('@/lib/daemon/daemon-local-client')
  // Fast path: a daemon that is already up answers the first ask, and the common
  // case should not pay for a step transition.
  const ready = await fetchDaemonDeviceId()
  if (ready) return ready

  return runStep('start-daemon', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    // Both spawn attempts are best-effort — the polling below decides the
    // outcome — so neither throw is the reported failure. Same shape as
    // `ensureHealthy`, including the restart fallback for a wedged supervisor.
    try {
      await invoke('daemon_ensure_running')
    } catch {
      try {
        await invoke('daemon_restart_managed')
      } catch {
        /* fall through to polling */
      }
    }
    for (let i = 0; i < DEVICE_ID_POLL_ATTEMPTS; i++) {
      const deviceId = await fetchDaemonDeviceId()
      if (deviceId) return deviceId
      if (i < DEVICE_ID_POLL_ATTEMPTS - 1) await sleep(DEVICE_ID_POLL_MS)
    }
    // Deliberately fatal rather than falling back to a generated id: a fresh id
    // means the server sees an unknown machine and provisions a *second* agent
    // for a machine that already has one.
    throw new Error(
      i18n.t(
        'settings.daemonOnboarding.deviceIdUnavailable',
        "Can't read this machine's id from the local daemon. Make sure amuxd is running, then retry.",
      ),
    )
  })
}

/**
 * Bind this machine's agent in `teamId` and rotate the daemon onto it.
 *
 * `displayName` is only consulted when the agent has to be created — the caller
 * has already looked the machine up (see `refresh`) and asked the user to name it
 * in that case. A rebind never renames: the user's chosen name outlives it.
 *
 * Replaces asking the user to pick team-vs-personal visibility, choose between
 * creating and binding, or reset a machine that belonged to another team.
 */
async function bindDeviceAgent(
  teamId: string,
  deviceId: string,
  displayName: string,
): Promise<{ agentId: string; created: boolean }> {
  const { invoke } = await import('@tauri-apps/api/core')
  const invite = await runStep('mint-invite', () => getBackend().actors.ensureAgentForDevice({
    teamId,
    deviceId,
    displayName,
  }))
  // Carry this app's effective Cloud API endpoint into the invite so the daemon
  // talks to the same backend the desktop build/runtime resolved — otherwise it
  // falls back to its own hardcoded default and diverges in non-prod builds.
  const { getEffectiveServerConfig } = await import('@/lib/config/server-config')
  const cloudApiUrl = (await getEffectiveServerConfig()).cloudApiUrl
  let inviteUrl = `${appScheme}://invite?token=${encodeURIComponent(invite.token)}`
  if (cloudApiUrl) {
    inviteUrl += `&cloud_api_url=${encodeURIComponent(cloudApiUrl)}`
  }
  const result = await runStep('init-daemon', () =>
    invoke<{ actorId: string; teamId: string }>('daemon_init', { inviteUrl }),
  )
  // `daemon_init` already claimed the invite and wrote fresh credentials — the
  // actor is onboarded to the team at this point. Restart the desktop-managed
  // amuxd so it reloads backend.toml. Failure here means credentials are on
  // disk but the running daemon may still hold the old identity — treat as
  // onboard failure. No `daemon_ensure_running` fallback: ensure is a no-op
  // when a (stale) daemon is already healthy, which would fake success.
  await runStep('restart-daemon', () => invoke('daemon_restart_managed'))
  rememberDaemonIdentity(teamId)
  invalidateDaemonConnection()
  if (result.actorId !== invite.agentId) {
    // The daemon reports which actor it claimed; if that disagrees with what the
    // server bound, later calls would address the wrong agent. Loud, because the
    // silent path has no user watching it.
    console.error(
      '[daemon-onboarding] claimed actor does not match the bound device agent',
      { claimed: result.actorId, bound: invite.agentId },
    )
  }
  return { agentId: invite.agentId, created: invite.created }
}

/**
 * Error copy for a failed bind.
 *
 * Deliberately not the "failed to start the local daemon" string: binding fails
 * for reasons that have nothing to do with the daemon starting (the Cloud API
 * refused, the machine id was unreadable, the team membership was gone), and
 * telling the user to check whether amuxd can run sends them somewhere useless.
 * Silent binding makes this worse than it used to be — nobody clicked anything,
 * so the message is all they have.
 */
function bindErrorMessage(e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e)
  return i18n.t(
    'settings.daemonOnboarding.bindFailed',
    "Couldn't set up this machine's agent: {{detail}}",
    { detail },
  )
}

/** After re-onboard, wait until `/v1/info` reports a healthy cloud session. */
async function waitForDaemonCloudAuthOk(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await fetchDaemonCloudAuthStatus()
    if (status === 'ok') return true
    if (status === 'expired') return false
    await sleep(500)
  }
  return (await fetchDaemonCloudAuthStatus()) === 'ok'
}

/** The daemon is onboarded to the current team — ensure it's actually running with a
 * valid token. Auto-recover (start/restart) and poll until healthy. Returns true if ready. */
async function ensureHealthy(): Promise<boolean> {
  let probe = await probeDaemonHttp()
  if (probe.ok) return true
  // Desktop-managed amuxd: restart the sidecar held by the desktop process.
  const { invoke } = await import('@tauri-apps/api/core')
  // Both spawn attempts are best-effort — polling below is what decides the
  // outcome — so this step is never the one blamed for a failure.
  await runStep('restart-daemon', async () => {
    try {
      await invoke('daemon_ensure_running')
    } catch {
      try {
        await invoke('daemon_restart_managed')
      } catch {
        /* fall through to polling */
      }
    }
  })
  // The long one: up to 6s per attempt, and `refresh` runs it twice.
  useDaemonOnboardingStore.setState({ step: 'await-daemon' })
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    invalidateDaemonConnection()
    probe = await probeDaemonHttp()
    if (probe.ok) {
      useDaemonOnboardingStore.setState((s) => ({
        completedSteps: s.completedSteps.includes('await-daemon')
          ? s.completedSteps
          : [...s.completedSteps, 'await-daemon'],
        step: null,
      }))
      return true
    }
  }
  useDaemonOnboardingStore.setState({ failedStep: 'await-daemon', step: null })
  return false
}

/**
 * Register the active UI workspace for this machine's agent — cloud row first
 * (same writer as the sidebar "+" button), then the local daemon mirror.
 *
 * First-login used to only call `register_daemon_workspace` as a best-effort
 * side effect after status flipped to ready. That raced the agent bind and
 * never told the sidebar to reload, so WORKSPACE stayed empty until a later
 * incidental refresh. Fix: after bind, POST /v1/workspaces with this machine's
 * agentId (user JWT).
 *
 * The local daemon mirror is best-effort and needs daemon cloud auth.
 */
async function ensureDefaultWorkspaceRegistered(teamId: string): Promise<void> {
  const { useWorkspaceStore } = await import('@/stores/workspace')
  const workspacePath = useWorkspaceStore.getState().workspacePath
  // Official `~/.amuxd/...` and white-label `~/.amuxd-<brand>/...` are daemon
  // state dirs, not user project workspaces.
  if (!workspacePath || /\/\.amuxd(-[^/]+)?\//.test(workspacePath)) return

  const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
  let agentId: string | null = null
  for (let i = 0; i < 20; i++) {
    agentId = await getLocalDaemonActorId()
    if (agentId) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!agentId) {
    throw new Error('local daemon agent id unavailable')
  }

  const name =
    workspacePath.replace(/\/+$/, '').split(/[/\\]/).pop() || workspacePath
  const memberId = useCurrentTeamStore.getState().currentMember?.id ?? null

  const {
    createDaemonWorkspace,
    getCurrentDaemonWorkspaceAgent,
    setAgentDefaultWorkspace,
  } = await import('@/lib/daemon/daemon-workspaces')

  // Cloud identity first so listDaemonWorkspaces(teamId, agentId) sees the row.
  const created = await createDaemonWorkspace({
    teamId,
    agentId,
    createdByMemberId: memberId,
    name,
    path: workspacePath,
  })

  const agent = await getCurrentDaemonWorkspaceAgent(teamId).catch(() => null)
  if (agent && !agent.defaultWorkspaceId) {
    try {
      await setAgentDefaultWorkspace(agentId, created.id)
    } catch (e) {
      console.warn('[daemon-onboarding] set default workspace failed', e)
    }
  }

  // Local daemon registry (cron / model catalog). Needs daemon cloud auth.
  // checkCloudSession already ran before us — if it left cloudAuthExpired,
  // skip without spinning; otherwise one probe is enough.
  if (useDaemonOnboardingStore.getState().cloudAuthExpired) return
  const auth = await fetchDaemonCloudAuthStatus()
  if (auth !== 'ok') return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('register_daemon_workspace', { workspacePath })
}

/**
 * After agent bind: register the default workspace. Cloud write does not wait
 * on daemon cloud auth; local mirror does (best-effort).
 */
async function maybeRegisterDefaultWorkspace(teamId: string | null): Promise<void> {
  if (!isTauri() || !teamId) return
  // Best-effort: never set failedStep / flip status to error.
  try {
    useDaemonOnboardingStore.setState({ step: 'register-workspace' })
    await ensureDefaultWorkspaceRegistered(teamId)
    useDaemonOnboardingStore.setState((s) => ({
      completedSteps: s.completedSteps.includes('register-workspace')
        ? s.completedSteps
        : [...s.completedSteps, 'register-workspace'],
      step: null,
    }))
  } catch (e) {
    useDaemonOnboardingStore.setState({ step: null })
    console.warn('[daemon-onboarding] workspace registration failed', e)
  }
}

/** The `refresh` in flight, so a second caller (the wizard's mount, a sidebar
 * retry) joins it instead of binding the machine a second time alongside it. */
let refreshInFlight: { teamId: string | null; promise: Promise<void> } | null = null

export const useDaemonOnboardingStore = create<DaemonOnboardingState>((set, get) => {
  /** End the enable run on failure: a machine that was off before it is
   * switched back off, and Retry is armed to enable again. */
  const failEnableRun = async (): Promise<void> => {
    const run = enableRun
    enableRun = null
    if (!run) return
    set({ retryEnable: { adopt: run.adopt } })
    if (!run.rollback) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('local_agent_disable')
      invalidateDaemonConnection()
      set({ enabled: false })
    } catch (e) {
      console.warn('[daemon-onboarding] rolling back a failed enable failed', e)
    }
  }

  /** End the enable run on success, adopting the default when it asked to. */
  const finishEnableRun = async (teamId: string | null): Promise<void> => {
    const run = enableRun
    enableRun = null
    set({ retryEnable: null })
    if (run?.adopt && teamId) await adoptDeviceAgentAsDefault(teamId)
  }

  /** `status: 'error'` plus the enable-run bookkeeping that goes with it. */
  const fail = async (patch: Partial<DaemonOnboardingState>): Promise<void> => {
    set({ ...patch, status: 'error', loaded: true })
    await failEnableRun()
  }

  const beginEnable = async (opts: { adopt: boolean }): Promise<void> => {
    const wasEnabled = get().enabled === true
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('local_agent_enable')
    enableRun = {
      teamId: useCurrentTeamStore.getState().team?.id ?? null,
      adopt: opts.adopt || !!enableRun?.adopt,
      rollback: enableRun?.rollback ?? !wasEnabled,
    }
    set({ enabled: true, retryEnable: null })
  }

  /**
   * The local Agent is off: decide from the team's defaults whether entering
   * the team needs it (#1678). Returns true when an enable was started and the
   * caller should carry on into the enabled path.
   */
  const decideWhileDisabled = async (teamId: string): Promise<boolean> => {
    // Undecided while the lookup runs. At launch `loaded` is still false and
    // the gate holds the skeleton; on an in-app team switch 'unknown' keeps the
    // shell up without acknowledging anything — leaving the previous team's
    // 'disabled' in place would wave this team in before its defaults were read.
    set({ status: 'unknown', error: null })
    let effective: string | null
    try {
      effective = (await getBackend().actors.getEffectiveDefaultAgent(teamId))?.trim() || null
    } catch (e) {
      // Never read a failed lookup as "no default": that would install a
      // runtime on a machine whose user only lost the network for a moment.
      set({
        status: 'defaults-error',
        loaded: true,
        error: i18n.t(
          'settings.daemonOnboarding.defaultsCheckFailed',
          "Couldn't check this team's default agent: {{detail}}",
          { detail: e instanceof Error ? e.message : String(e) },
        ),
      })
      return false
    }
    if (effective) {
      set({ status: 'disabled', loaded: true, error: null })
      return false
    }
    // Neither the member nor the team has a default: without this machine's
    // agent there is nobody to talk to. Enable, and make it the default.
    try {
      await beginEnable({ adopt: true })
    } catch (e) {
      set({ retryEnable: { adopt: true } })
      set({ status: 'error', loaded: true, error: bindErrorMessage(e) })
      return false
    }
    return true
  }

  /**
   * Look this machine up in `teamId`, then either bind it silently or park a name
   * prompt. Returns 'bound' | 'prompting'; throws on failure so each caller
   * decides how to report it.
   *
   * Every binding path funnels through here so that "the user is only ever asked
   * on first creation" holds for all three of them: a fresh machine, a machine
   * arriving from another team, and a linked-account switch.
   */
  const bindOrPrompt = async (teamId: string): Promise<'bound' | 'prompting'> => {
    const deviceId = await requireDeviceId()
    const existing = await getBackend().actors.findAgentForDevice({ teamId, deviceId })
    if (!existing.agentId) {
      set({
        pendingName: { teamId, deviceId, suggested: await deviceDisplayName() },
      })
      // Binding resumes in nameDeviceAgent. Nothing is written until then, so
      // abandoning this screen leaves no half-created agent behind.
      return 'prompting'
    }
    // The stored name is passed through only to satisfy the API's create path;
    // ensure-for-device ignores it for an agent that already exists.
    await bindDeviceAgent(teamId, deviceId, existing.displayName || (await deviceDisplayName()))
    return 'bound'
  }

  const refreshOnce = async (opts?: { forceIdentityRebind?: boolean }): Promise<void> => {
    if (!isTauri()) {
      set({ status: 'ready', loaded: true })
      return
    }
    markStartup('daemon-refresh:start')
    const currentTeamId = useCurrentTeamStore.getState().team?.id ?? null
    // An enable started for another team (the user switched away from the
    // setup screen) is abandoned, not carried over: the new team decides for
    // itself whether it needs this machine's agent.
    if (enableRun && enableRun.teamId !== currentTeamId) {
      set({ pendingName: null })
      await failEnableRun()
      set({ retryEnable: null })
    }
    const enabled = enableRun ? true : await readLocalAgentEnabled()
    set({ enabled })
    if (!enabled) {
      if (!currentTeamId) {
        set({ status: 'unknown', loaded: true })
        markStartup('daemon-refresh:end')
        return
      }
      const started = await decideWhileDisabled(currentTeamId)
      if (!started) {
        markStartup('daemon-refresh:end')
        return
      }
    }
    const dTeam = await daemonTeamId()
    markStartup('daemon-teamid:end')
    const base = computeOnboardingStatus(dTeam, currentTeamId)
    if (base !== 'ready') {
      // 'unknown' means no current team yet — there is nothing to bind to, and
      // the auth gate lets it through rather than blocking on it.
      if (base === 'unknown' || !currentTeamId) {
        set({ status: base, loaded: true })
        markStartup('daemon-refresh:end')
        return
      }
      // 'needs-onboard' (fresh machine) and 'mismatch' (bound to another team)
      // are the same job: get this machine's agent in the current team and rotate
      // the daemon onto it. amuxd is single-team, so the previous team's agent is
      // left intact — switching back finds it again by device id instead of
      // creating another.
      //
      // Look up before binding. A machine the team already knows is bound with no
      // interaction; a machine it does not gets to ask the user for a name, which
      // can only be applied at creation.
      beginRun()
      set({ status: 'starting', loaded: true, busy: true, error: null })
      let outcome: 'bound' | 'prompting'
      try {
        outcome = await bindOrPrompt(currentTeamId)
      } catch (e) {
        await fail({ error: bindErrorMessage(e) })
        return
      } finally {
        set({ busy: false })
      }
      if (outcome === 'prompting') {
        markStartup('daemon-refresh:end')
        return
      }
      // Re-read daemon.toml and health after init/restart before releasing the
      // auth gate to the chat UI. Not `get().refresh()`: that would join the
      // run in flight — this one — and wait on itself.
      await refreshOnce()
      return
    }
    const currentUserId = currentAuthUserId()
    const recorded = readDaemonOnboardingIdentity()
    // Same team does not imply the same daemon authority: a linked-account switch
    // leaves the daemon holding credentials minted by the other account. Re-bind
    // before it publishes commands/workspaces under the wrong authority.
    //
    // Only the recorded identity is consulted. The old code also asked the Cloud
    // API whether this user owned the local actor, to cover installs predating
    // the record; that check is what `ensure-for-device` now does server-side —
    // an agent owned by someone else counts as absent and this account gets its
    // own.
    const identityChanged = !!currentUserId && !!(
      opts?.forceIdentityRebind ||
      (recorded?.teamId === currentTeamId && recorded.userId !== currentUserId)
    )
    if (identityChanged) {
      beginRun()
      set({ status: 'starting', loaded: true, busy: true, error: null })
      let outcome: 'bound' | 'prompting'
      try {
        outcome = await bindOrPrompt(currentTeamId!)
      } catch (e) {
        await fail({ error: bindErrorMessage(e) })
        return
      } finally {
        set({ busy: false })
      }
      // The newly selected account may own no agent for this machine — it names
      // its own rather than inheriting the other account's.
      if (outcome === 'prompting') {
        markStartup('daemon-refresh:end')
        return
      }
    }
    // Onboarded to the current team: also verify running + token valid, auto-recover.
    const first = await probeDaemonHttp()
    markStartup('daemon-refresh:end')
    if (first.ok) {
      // The gate must not open onto a machine that cannot run an agent.
      if (!(await ensureRuntimeReady())) {
        await failEnableRun()
        return
      }
      set({ status: 'ready', loaded: true })
      await finishEnableRun(currentTeamId)
      // Heal the daemon's cloud session before workspace upsert — otherwise
      // `POST /v1/workspaces` fails with 500 while the refresh token is dead.
      await get().checkCloudSession()
      await maybeRegisterDefaultWorkspace(currentTeamId)
      return
    }
    beginRun()
    set({ status: 'starting', loaded: true, error: null })
    let ok = await ensureHealthy()
    if (!ok) ok = await ensureHealthy()
    if (ok && !(await ensureRuntimeReady())) {
      await failEnableRun()
      return
    }
    if (!ok) {
      await fail({
        error: i18n.t(
          'settings.daemonOnboarding.startFailed',
          'Failed to start the local daemon. Make sure it can run on this machine, then retry.',
        ),
      })
      return
    }
    set({ status: 'ready', loaded: true, error: null })
    await finishEnableRun(currentTeamId)
    await get().checkCloudSession()
    await maybeRegisterDefaultWorkspace(currentTeamId)
  }

  return {
  status: 'unknown',
  enabled: null,
  retryEnable: null,
  loaded: false,
  busy: false,
  error: null,
  cloudAuthExpired: false,
  healing: false,
  healError: null,
  step: null,
  completedSteps: [],
  failedStep: null,
  daemonOutdated: false,
  runStartedAt: null,
  completedAgent: null,
  pendingName: null,

  nameDeviceAgent: async (name) => {
    const pending = get().pendingName
    if (!pending) return
    const displayName = name.trim() || pending.suggested
    beginRun()
    set({ status: 'starting', busy: true, error: null, pendingName: null, completedAgent: null })
    try {
      const bound = await bindDeviceAgent(pending.teamId, pending.deviceId, displayName)
      // Recorded before refresh so the naming screen can confirm what was set up
      // rather than simply disappearing once status flips to 'ready'.
      set({ completedAgent: { agentId: bound.agentId, displayName } })
    } catch (e) {
      // Put the prompt back: the name the user typed was never applied, so
      // dropping it would leave the retry button creating an unnamed agent.
      set({ status: 'error', error: bindErrorMessage(e), pendingName: pending })
      return
    } finally {
      set({ busy: false })
    }
    await get().refresh({ fresh: true })
  },

  refresh: async (opts) => {
    const teamId = useCurrentTeamStore.getState().team?.id ?? null
    const running = refreshInFlight
    // Same team, nothing extra asked: the run in flight answers this call too.
    // `fresh` callers changed something the running one has not seen (the
    // switch was just turned on, a name was just applied) and queue behind it.
    if (running && running.teamId === teamId && !opts?.forceIdentityRebind && !opts?.fresh) {
      return running.promise
    }
    const promise = (async () => {
      if (running) await running.promise.catch(() => {})
      await refreshOnce(opts)
    })()
    refreshInFlight = { teamId, promise }
    try {
      await promise
    } finally {
      if (refreshInFlight?.promise === promise) refreshInFlight = null
    }
  },

  loadEnabled: async () => {
    if (!isTauri()) return false
    const enabled = enableRun ? true : await readLocalAgentEnabled()
    set({ enabled })
    return enabled
  },

  enable: async (opts) => {
    if (!isTauri()) return
    beginRun()
    set({ status: 'starting', loaded: true, error: null })
    try {
      await beginEnable({ adopt: !!opts?.adoptAsDefault })
    } catch (e) {
      set({ retryEnable: { adopt: !!opts?.adoptAsDefault } })
      set({ status: 'error', loaded: true, error: bindErrorMessage(e) })
      return
    }
    await get().refresh({ fresh: true })
  },

  disable: async () => {
    if (!isTauri()) return
    set({ busy: true, error: null })
    try {
      const teamId = useCurrentTeamStore.getState().team?.id ?? null
      // Read the id before amuxd stops — afterwards nothing answers /v1/info.
      const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
      const { getKnownLocalDaemonActorId } = await import('@/lib/daemon/local-daemon-identity')
      const localAgentId = (await getLocalDaemonActorId()) ?? getKnownLocalDaemonActorId()
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('local_agent_disable')
      enableRun = null
      invalidateDaemonConnection()
      set({ enabled: false, retryEnable: null, cloudAuthExpired: false, healError: null })
      if (teamId && localAgentId) {
        try {
          const prefs = useMemberPreferencesStore.getState()
          await prefs.ensureLoaded(teamId)
          if (useMemberPreferencesStore.getState().defaultAgentId === localAgentId) {
            await useMemberPreferencesStore.getState().setDefaultAgent(teamId, null)
          }
        } catch (e) {
          console.warn('[daemon-onboarding] clearing the member default after disable failed', e)
        }
        void useMemberPreferencesStore.getState().loadEffectiveDefaultAgent(teamId)
      }
      const { useWorkspaceStore } = await import('@/stores/workspace')
      useWorkspaceStore.getState().setDaemonHttpReady(false)
      set({ status: 'disabled', loaded: true })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      throw e
    } finally {
      set({ busy: false })
    }
  },

  retry: async () => {
    const pending = get().retryEnable
    if (pending) {
      await get().enable({ adoptAsDefault: pending.adopt })
      return
    }
    await get().refresh({ fresh: true })
  },


  forceReset: async () => {
    if (!isTauri()) return
    set({ busy: true, error: null })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('daemon_clear')
      clearDaemonOnboardingIdentity()
      // Verify rather than assume. `amuxd clear` exiting 0 does not prove the
      // binding is gone — the config dir has been resurrected from the legacy
      // dir before, and a live daemon can rewrite the file. Without this check
      // the wizard just re-renders the same "belongs to another team" screen
      // with no error, which reads as a dead button.
      const stillBound = await daemonTeamId()
      if (stillBound) {
        set({
          error: i18n.t('settings.daemonOnboarding.resetIncomplete', {
            teamId: stillBound,
            path: daemonManagedLogDisplayPath,
            defaultValue:
              'Reset did not take effect: this machine is still bound to team {{teamId}}. Check {{path}}.',
          }),
        })
        return
      }
      // Optimistically clear the mismatch screen while refresh re-resolves.
      set({ status: 'unknown' })
      await get().refresh({ fresh: true })
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  checkCloudSession: async (opts?: { allowRetryAfterHealError?: boolean }) => {
    if (!isTauri()) return
    const status = await runStep('cloud-auth', fetchDaemonCloudAuthStatus)
    if (status !== 'expired') {
      // Healthy / unknown (older daemon or transient) — clear any stale banner.
      if (get().cloudAuthExpired) set({ cloudAuthExpired: false })
      return
    }
    set({ cloudAuthExpired: true })
    if (opts?.allowRetryAfterHealError) set({ healError: null })
    // Auto-heal exactly once. A prior failure (`healError`) or an in-flight heal
    // suppresses further automatic attempts so a non-owner daemon never spins;
    // the banner's retry button drives subsequent attempts explicitly.
    if (!get().healing && (!get().healError || opts?.allowRetryAfterHealError)) {
      await get().autoHealCloudSession()
    }
  },

  autoHealCloudSession: async () => {
    if (!isTauri() || get().healing) return
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return
    set({ healing: true, healError: null })
    try {
      // Re-bind by device id: the lookup lands on the actor this machine is
      // already running as, and `amuxd init` rotates fresh credentials onto it.
      // No ownership pre-check is needed — that used to be a client-side guess at
      // what create_team_invite enforces. The one case where the lookup comes back
      // empty is a machine now signed in as a different account, and that account
      // names its own agent rather than seeing an error it cannot act on.
      const outcome = await bindOrPrompt(teamId)
      if (outcome === 'prompting') {
        // The naming screen owns the rest; the banner should stop claiming a heal
        // is in flight.
        return
      }
      const authOk = await waitForDaemonCloudAuthOk()
      set({ cloudAuthExpired: !authOk })
      // Inside a refresh (its cloud-auth step lands here) that refresh carries
      // on by itself; calling it again would join it and wait on itself.
      if (!refreshInFlight) await get().refresh()
    } catch (e) {
      set({ healError: bindErrorMessage(e) })
    } finally {
      set({ healing: false })
    }
  },
  }
})
