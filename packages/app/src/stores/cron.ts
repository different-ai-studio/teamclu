import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { withAsync } from '@/lib/store-utils'
import { getPreferredLanguage } from '@/lib/locale'
import i18n from '@/lib/i18n'
import { ensureCronSessionVisible, hydrateCronSessionMessages } from '@/lib/cron/cron-session-messages'
// ==================== Types ====================

export type ScheduleKind = 'at' | 'every' | 'cron'
export type CronScope = 'global' | 'workspace'

function cronInvokeArgs(scope: CronScope, selectedWorkspacePath: string | null) {
  return {
    scope,
    workspacePath: scope === 'workspace' ? selectedWorkspacePath : null,
  }
}

// "Run Now" watches for the cloud session id the daemon stamps onto this run's
// record, so the UI can jump straight to the session instead of blocking until
// the whole turn finishes. The scheduler creates the cloud session eagerly
// (via `cron-prepare-session`) and stamps `session_id` into the run record
// within a second or two of clicking — well before the ACP turn completes —
// so it surfaces in `cron_get_runs` almost immediately.
const RUN_JOB_SESSION_POLL_INTERVAL_MS = 1000
// Even with eager creation, a run whose prepare is queued behind another
// in-flight cron turn (the daemon serializes turns) can take longer. Keep the
// window well above the worst case so it still navigates instead of silently
// giving up.
const RUN_JOB_SESSION_MAX_POLL_MS = 5 * 60 * 1000

/**
 * Poll this job's run records until the run started by our `cron_run_job` call
 * (a run id not present in `knownRunIds`) has a `sessionId` stamped, and return
 * it. Returns null on timeout. The scheduler stamps `sessionId` early (eager
 * session prepare), so this usually resolves within a couple of polls.
 */
async function detectNewRunSession(
  jobId: string,
  scope: CronScope,
  selectedWorkspacePath: string | null,
  knownRunIds: Set<string>,
): Promise<string | null> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < RUN_JOB_SESSION_MAX_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, RUN_JOB_SESSION_POLL_INTERVAL_MS))
    let runs: CronRunRecord[]
    try {
      runs = await invoke<CronRunRecord[]>('cron_get_runs', {
        jobId,
        limit: 10,
        ...cronInvokeArgs(scope, selectedWorkspacePath),
      })
    } catch {
      continue // Transient failure — keep polling.
    }
    const fresh = runs.find((run) => !knownRunIds.has(run.runId) && !!run.sessionId)
    if (fresh?.sessionId) return fresh.sessionId
  }
  return null
}

/**
 * Record the job's model as this session's pick, for the local daemon agent.
 *
 * The pick is the top of `selectAgentModel`'s order, so the composer pill names
 * the model the run is actually on, and the RuntimeStart the desktop fires on
 * arrival starts its runtime there too. Everything cheaper was too late: the
 * transcript is the other source of the session's model, and on arrival it
 * holds one message the desktop has not fetched yet.
 *
 * Best-effort — a job with no pinned model, or an unresolvable daemon actor,
 * simply leaves the existing resolution order alone.
 */
async function pinJobModelToSession(sessionId: string, jobId: string): Promise<void> {
  try {
    const model = useCronStore.getState().jobs.find((j) => j.id === jobId)?.payload.model?.trim()
    if (!model) return
    const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
    const agentActorId = (await getLocalDaemonActorId())?.trim()
    if (!agentActorId) return
    const { useAgentModelPickStore } = await import('@/stores/agent-model-pick-store')
    useAgentModelPickStore.getState().setPick(sessionId, agentActorId, model)
  } catch {
    // Non-fatal: the pill falls back to the transcript / retain order.
  }
}

/**
 * Fire-and-forget: keep polling this run after we've already navigated to its
 * session, and if it ends in failure/timeout, seed a fallback message into the
 * session so opening it later (e.g. from the plain session list, not the run
 * history dialog) explains why the agent never replied instead of showing a
 * blank thread.
 */
async function watchRunOutcomeAndSeedFailureMessage(
  jobId: string,
  sessionId: string,
  scope: CronScope,
  selectedWorkspacePath: string | null,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < RUN_JOB_SESSION_MAX_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, RUN_JOB_SESSION_POLL_INTERVAL_MS))
    let runs: CronRunRecord[]
    try {
      runs = await invoke<CronRunRecord[]>('cron_get_runs', {
        jobId,
        limit: 10,
        ...cronInvokeArgs(scope, selectedWorkspacePath),
      })
    } catch {
      continue // Transient failure — keep polling.
    }
    const run = runs.find((r) => r.sessionId === sessionId)
    if (!run || run.status === 'running') continue

    if (run.status === 'failed' || run.status === 'timeout' || run.error) {
      const summary = run.error
        ? i18n.t('settings.cron.runFailedFallback', { error: run.error })
        : run.responseSummary
      try {
        // No-ops if the cloud already has real messages for this session.
        await hydrateCronSessionMessages(sessionId, { fallbackSummary: summary, runId: run.runId })
      } catch {
        // Non-fatal: the run record still carries the error for the history dialog.
      }
    }
    return
  }
}

export interface CronSchedule {
  kind: ScheduleKind
  at?: string // ISO 8601 for one-time
  everyMs?: number // Interval in milliseconds
  expr?: string // 5-field cron expression
  tz?: string // IANA timezone
}

export interface CronPayload {
  message: string
  model?: string // "provider/model"
  /** Backend the job runs on: "opencode" | "claude" | "codex". Absent/empty
   *  means "auto" — the daemon uses its default_agent_type. Pairs with `model`,
   *  whose `provider/model` ref is selected from this backend's catalog group. */
  backend?: string
  /** @deprecated Compatibility only. Runtime ignores this and new saves omit it. */
  timeoutSeconds?: number
  /** Permission mode for the run. `'full_access'` (the default, including for
   *  jobs saved before this field existed) skips every approval prompt: a cron
   *  run is unattended, so an approval nobody answers just burns the timeout.
   *  `'default'` keeps asking — only useful while watching the run live. */
  permissionMode?: CronPermissionMode
}

export type CronPermissionMode = 'full_access' | 'default'

type DeliveryMode = 'announce' | 'none'
export type DeliveryChannel = 'discord' | 'feishu' | 'email' | 'kook' | 'wechat' | 'wecom' | 'seatalk'

export interface CronDelivery {
  mode: DeliveryMode
  channel: DeliveryChannel
  to: string
  bestEffort: boolean
}

type RunStatus = 'success' | 'failed' | 'timeout' | 'running' | 'stale'

export interface CronJob {
  id: string
  name: string
  description?: string
  enabled: boolean
  schedule: CronSchedule
  payload: CronPayload
  delivery?: CronDelivery
  deleteAfterRun: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface CronRunRecord {
  runId: string
  jobId: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  lastHeartbeatAt?: string
  sessionId?: string
  responseSummary?: string
  deliveryStatus?: string
  error?: string
}

export interface CreateCronJobRequest {
  name: string
  description?: string
  enabled: boolean
  schedule: CronSchedule
  payload: CronPayload
  delivery?: CronDelivery
  deleteAfterRun: boolean
}

export interface UpdateCronJobRequest {
  id: string
  name?: string
  description?: string
  enabled?: boolean
  schedule?: CronSchedule
  payload?: CronPayload
  delivery?: CronDelivery | null
  deleteAfterRun?: boolean
}

// ==================== Store ====================

interface CronState {
  jobs: CronJob[]
  isLoading: boolean
  error: string | null
  isInitialized: boolean
  activeScope: CronScope
  selectedWorkspacePath: string | null

  // Optimistic overlay of just-created cron session ids, for the session-list
  // filter. Scheduled sessions are identified by their persisted `source ===
  // 'cron'`; this set only covers a freshly-created session whose list row
  // hasn't synced `source` yet (see runJob).
  cronSessionIds: Set<string>
  // Toggle to show only cron sessions in the session list
  showCronSessions: boolean

  // Run history for the currently viewed job
  selectedJobId: string | null
  runs: CronRunRecord[]
  runsLoading: boolean
  /** Job IDs currently executing via manual "Run Now". */
  runningJobIds: Set<string>

  // Actions
  init: () => Promise<void>
  reinit: () => Promise<void>
  setScope: (scope: CronScope) => Promise<void>
  setSelectedWorkspacePath: (workspacePath: string | null) => Promise<void>
  loadJobs: () => Promise<void>
  addJob: (request: CreateCronJobRequest) => Promise<CronJob>
  updateJob: (request: UpdateCronJobRequest) => Promise<CronJob>
  removeJob: (jobId: string) => Promise<void>
  toggleEnabled: (jobId: string, enabled: boolean) => Promise<void>
  runJob: (jobId: string) => Promise<void>
  loadRuns: (jobId: string, limit?: number) => Promise<void>
  refreshDelivery: () => Promise<void>
  clearError: () => void
  setSelectedJobId: (jobId: string | null) => void
  setShowCronSessions: (show: boolean) => void
  toggleShowCronSessions: () => void
}

export const useCronStore = create<CronState>((set, get) => ({
  jobs: [],
  isLoading: false,
  error: null,
  isInitialized: false,
  activeScope: 'global',
  selectedWorkspacePath: null,

  cronSessionIds: new Set<string>(),
  showCronSessions: false,

  selectedJobId: null,
  runs: [],
  runsLoading: false,
  runningJobIds: new Set<string>(),

  init: async () => {
    const alreadyInit = get().isInitialized
    if (alreadyInit) {
      console.log('[Cron] Already initialized, skipping')
      return
    }
    try {
      await invoke('cron_init', cronInvokeArgs(get().activeScope, get().selectedWorkspacePath))
      set({ isInitialized: true })
      await get().loadJobs()
    } catch (error) {
      console.error('[Cron] Init failed:', error)
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  reinit: async () => {
    try {
      set({ isInitialized: false })
      await invoke('cron_init', cronInvokeArgs(get().activeScope, get().selectedWorkspacePath))
      set({ isInitialized: true })
      await get().loadJobs()
    } catch (error) {
      console.error('[Cron] Re-init failed:', error)
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  setScope: async (scope: CronScope) => {
    set({
      activeScope: scope,
      isInitialized: false,
      jobs: [],
      error: null,
    })
    await get().reinit()
  },

  setSelectedWorkspacePath: async (workspacePath: string | null) => {
    if (workspacePath === get().selectedWorkspacePath) return
    set({
      selectedWorkspacePath: workspacePath,
      isInitialized: false,
      jobs: [],
      runs: [],
      selectedJobId: null,
      error: null,
    })
    await get().reinit()
  },

  loadJobs: async () => {
    if (!get().isInitialized) {
      await get().init()
      return
    }

    await withAsync(set, async () => {
      const jobs = await invoke<CronJob[]>(
        'cron_list_jobs',
        cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      )
      set({ jobs })
    })
  },

  addJob: async (request: CreateCronJobRequest) => {
    const job = await withAsync(set, async () => {
      const job = await invoke<CronJob>('cron_add_job', {
        request,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: [...state.jobs, job],
      }))
      return job
    }, { rethrow: true })
    return job!
  },

  updateJob: async (request: UpdateCronJobRequest) => {
    const updated = await withAsync(set, async () => {
      const updated = await invoke<CronJob>('cron_update_job', {
        request,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: state.jobs.map((j) => (j.id === updated.id ? updated : j)),
      }))
      return updated
    }, { rethrow: true })
    return updated!
  },

  removeJob: async (jobId: string) => {
    await withAsync(set, async () => {
      await invoke('cron_remove_job', {
        jobId,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: state.jobs.filter((j) => j.id !== jobId),
        selectedJobId: state.selectedJobId === jobId ? null : state.selectedJobId,
      }))
    }, { rethrow: true })
  },

  toggleEnabled: async (jobId: string, enabled: boolean) => {
    try {
      await invoke('cron_toggle_enabled', {
        jobId,
        enabled,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set((state) => ({
        jobs: state.jobs.map((j) =>
          j.id === jobId ? { ...j, enabled } : j
        ),
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  runJob: async (jobId: string) => {
    if (get().runningJobIds.has(jobId)) return

    const markRunning = () =>
      set((state) => ({
        runningJobIds: new Set([...state.runningJobIds, jobId]),
      }))
    const markIdle = () =>
      set((state) => {
        const runningJobIds = new Set(state.runningJobIds)
        runningJobIds.delete(jobId)
        return { runningJobIds }
      })

    markRunning()
    const { activeScope, selectedWorkspacePath } = get()

    // Snapshot the run ids that exist *before* this run so we can recognize the
    // one our cron_run_job creates (and read its stamped session id).
    let knownRunIds = new Set<string>()
    try {
      const priorRuns = await invoke<CronRunRecord[]>('cron_get_runs', {
        jobId,
        limit: 20,
        ...cronInvokeArgs(activeScope, selectedWorkspacePath),
      })
      knownRunIds = new Set(priorRuns.map((run) => run.runId))
    } catch {
      // No prior runs / transient failure — every run reads as new, which is fine.
    }

    try {
      await invoke('cron_run_job', {
        jobId,
        ...cronInvokeArgs(activeScope, selectedWorkspacePath),
      })

      const sessionId = await detectNewRunSession(
        jobId,
        activeScope,
        selectedWorkspacePath,
        knownRunIds,
      )
      void get().loadJobs()

      if (sessionId) {
        // Optimistically mark this brand-new session as cron-origin. Scheduled
        // sessions are identified by their persisted `source === 'cron'`, but
        // the list row for a session created moments ago may not have synced
        // that field yet, so seed the overlay to avoid a flicker when the filter
        // is on. The synced `source` takes over on the next list refresh.
        set((state) => ({ cronSessionIds: new Set([...state.cronSessionIds, sessionId]) }))
        get().setShowCronSessions(true)
        // The session-list-store's paginated `rows` won't have this brand-new
        // session yet either — it only refreshes on its own poll/reload. Upsert
        // it in directly so the sidebar shows it right away instead of needing
        // an unrelated reload (e.g. toggling the cron filter) to surface it.
        try {
          await ensureCronSessionVisible(sessionId)
        } catch {
          // Non-fatal: the session still exists and will show up once the
          // list store's next reload picks it up.
        }
        // Pin the job's model onto the session before navigating. We land in a
        // session whose only message is a prompt the desktop has not fetched
        // yet, so nothing else can tell the composer — or the runtime the
        // desktop is about to start — which model this run is on; both fell
        // back to the device MRU and named a model the job never chose.
        await pinJobModelToSession(sessionId, jobId)
        // Keep watching after we navigate away — if the run ends in failure,
        // seed an explanatory message into the session (see fn doc above).
        void watchRunOutcomeAndSeedFailureMessage(jobId, sessionId, activeScope, selectedWorkspacePath)
        // Close the settings pane, jump to the main chat view, and open the
        // session so the user watches it run live.
        const { useUIStore } = await import('@/stores/ui')
        await useUIStore.getState().switchToSession(sessionId)
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      markIdle()
    }
  },

  loadRuns: async (jobId: string, limit?: number) => {
    set({ runsLoading: true, selectedJobId: jobId })
    try {
      const runs = await invoke<CronRunRecord[]>('cron_get_runs', {
        jobId,
        limit: limit ?? 50,
        ...cronInvokeArgs(get().activeScope, get().selectedWorkspacePath),
      })
      set({ runs: runs.map(normalizeCronRunRecord), runsLoading: false })
    } catch (error) {
      console.error('[Cron] Failed to load runs:', error)
      set({ runs: [], runsLoading: false })
    }
  },

  refreshDelivery: async () => {
    try {
      await invoke('cron_refresh_delivery')
    } catch (error) {
      console.error('[Cron] Failed to refresh delivery:', error)
    }
  },

  clearError: () => set({ error: null }),
  setSelectedJobId: (jobId: string | null) => set({ selectedJobId: jobId }),
  setShowCronSessions: (show) => set({ showCronSessions: show }),
  toggleShowCronSessions: () => set(s => ({ showCronSessions: !s.showCronSessions })),
}))

// ==================== Helpers ====================

const LEGACY_TIMEOUT_CUT_SHORT_MARKER = 'AI response was cut short after'

export function normalizeCronRunRecord(record: CronRunRecord): CronRunRecord {
  const hasLegacyTimeoutText =
    record.responseSummary?.includes(LEGACY_TIMEOUT_CUT_SHORT_MARKER) ||
    record.error?.includes(LEGACY_TIMEOUT_CUT_SHORT_MARKER)

  if (record.status === 'success' && hasLegacyTimeoutText) {
    return { ...record, status: 'timeout' }
  }

  return record
}

/** Convert schedule to human-readable string */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      if (schedule.at) {
        try {
          const date = new Date(schedule.at)
          return `One-time: ${date.toLocaleString()}`
        } catch {
          return `One-time: ${schedule.at}`
        }
      }
      return 'One-time'
    case 'every': {
      if (!schedule.everyMs) return 'Interval'
      const ms = schedule.everyMs
      if (ms < 60000) return `Every ${Math.round(ms / 1000)}s`
      if (ms < 3600000) return `Every ${Math.round(ms / 60000)} min`
      if (ms < 86400000) return `Every ${Math.round(ms / 3600000)}h`
      return `Every ${Math.round(ms / 86400000)} days`
    }
    case 'cron':
      return schedule.expr
        ? `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`
        : 'Cron'
    default:
      return 'Unknown'
  }
}

/** Format a relative time string with i18n support (e.g., "2 minutes ago" / "2分钟前") */
export function formatRelativeTime(dateStr: string): string {
  try {
    const lang = getPreferredLanguage()
    const date = new Date(dateStr)
    const now = new Date()
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })

    // Future (e.g. next cron run): diffInSeconds is negative. Must not reuse the "past" branch,
    // or every future time would incorrectly show as "Just now" (negative < 60).
    if (diffInSeconds < 0) {
      const ahead = -diffInSeconds
      if (ahead < 60) {
        return rtf.format(1, 'minute')
      }
      if (ahead < 3600) {
        return rtf.format(Math.max(1, Math.round(ahead / 60)), 'minute')
      }
      if (ahead < 86400) {
        return rtf.format(Math.max(1, Math.round(ahead / 3600)), 'hour')
      }
      if (ahead < 2592000) {
        return rtf.format(Math.max(1, Math.round(ahead / 86400)), 'day')
      }
      if (ahead < 31536000) {
        return rtf.format(Math.max(1, Math.round(ahead / 2592000)), 'month')
      }
      return rtf.format(Math.max(1, Math.round(ahead / 31536000)), 'year')
    }

    // Past / now
    if (diffInSeconds < 60) {
      if (diffInSeconds <= 0) {
        return lang === 'zh' || lang === 'zh-CN' ? '刚刚' : 'Just now'
      }
      return rtf.format(-diffInSeconds, 'second')
    }
    if (diffInSeconds < 3600) {
      return rtf.format(-Math.floor(diffInSeconds / 60), 'minute')
    }
    if (diffInSeconds < 86400) {
      return rtf.format(-Math.floor(diffInSeconds / 3600), 'hour')
    }
    if (diffInSeconds < 2592000) {
      return rtf.format(-Math.floor(diffInSeconds / 86400), 'day')
    }
    if (diffInSeconds < 31536000) {
      return rtf.format(-Math.floor(diffInSeconds / 2592000), 'month')
    }
    return rtf.format(-Math.floor(diffInSeconds / 31536000), 'year')
  } catch {
    return dateStr
  }
}

/** Get run status color */
export function getRunStatusColor(status: RunStatus): string {
  switch (status) {
    case 'success':
      return 'text-green-500'
    case 'failed':
      return 'text-red-500'
    case 'timeout':
      return 'text-orange-500'
    case 'running':
      return 'text-blue-500'
    case 'stale':
      return 'text-yellow-500'
    default:
      return 'text-muted-foreground'
  }
}

/** Channel display name */
export function getChannelDisplayName(channel: DeliveryChannel): string {
  switch (channel) {
    case 'discord':
      return 'Discord'
    case 'feishu':
      return 'Feishu'
    case 'email':
      return 'Email'
    case 'kook':
      return 'KOOK'
    case 'wechat':
      return 'WeChat'
    case 'wecom':
      return 'WeCom'
    case 'seatalk':
      return 'SeaTalk'
    default:
      return channel
  }
}
