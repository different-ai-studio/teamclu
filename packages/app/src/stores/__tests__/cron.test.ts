import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ scope: 'global',
      workspacePath: null }),
  },
}))

const mockSwitchToSession = vi.fn()

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({ switchToSession: mockSwitchToSession }),
  },
}))

vi.mock('@/lib/store-utils', () => ({
  withAsync: async (set: any, fn: any, opts?: any) => {
    set({ isLoading: true, error: null })
    try {
      const result = await fn()
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), isLoading: false })
      if (opts?.rethrow) throw error
    }
  },
}))

import {
  useCronStore,
  formatSchedule,
  formatRelativeTime,
  getRunStatusColor,
  getChannelDisplayName,
  normalizeCronRunRecord,
} from '@/stores/cron'

describe('cron store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCronStore.setState({
      jobs: [],
      isLoading: false,
      error: null,
      isInitialized: false,
      activeScope: 'global',
      selectedWorkspacePath: null,
      selectedJobId: null,
      runs: [],
      runsLoading: false,
      runningJobIds: new Set<string>(),
      cronSessionIds: new Set<string>(),
      showCronSessions: false,
    })
  })

  it('has correct initial state', () => {
    const state = useCronStore.getState()
    expect(state.jobs).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.isInitialized).toBe(false)
  })

  it('init calls cron_init and loads jobs', async () => {
    mockInvoke.mockResolvedValueOnce(undefined) // cron_init
    mockInvoke.mockResolvedValueOnce([]) // cron_list_jobs via loadJobs
    await useCronStore.getState().init()
    expect(mockInvoke).toHaveBeenCalledWith('cron_init', {
      scope: 'global',
      workspacePath: null,
    })
    expect(useCronStore.getState().isInitialized).toBe(true)
  })

  it('passes null workspace path for workspace scope when none is selected', async () => {
    useCronStore.setState({
      activeScope: 'workspace',
      selectedWorkspacePath: null,
    })
    mockInvoke.mockResolvedValueOnce(undefined)
    mockInvoke.mockResolvedValueOnce([])

    await useCronStore.getState().init()

    expect(mockInvoke).toHaveBeenCalledWith('cron_init', {
      scope: 'workspace',
      workspacePath: null,
    })
  })

  it('uses the selected workspace for workspace-scoped init and list calls', async () => {
    useCronStore.setState({
      activeScope: 'workspace',
      selectedWorkspacePath: '/daemon/workspace-b',
    })
    mockInvoke.mockResolvedValueOnce(undefined) // cron_init
    mockInvoke.mockResolvedValueOnce([]) // cron_list_jobs

    await useCronStore.getState().init()

    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'cron_init', {
      scope: 'workspace',
      workspacePath: '/daemon/workspace-b',
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'cron_list_jobs', {
      scope: 'workspace',
      workspacePath: '/daemon/workspace-b',
    })
  })

  it('clearError resets error', () => {
    useCronStore.setState({ error: 'fail' })
    useCronStore.getState().clearError()
    expect(useCronStore.getState().error).toBeNull()
  })

  it('setSelectedJobId updates selected job', () => {
    useCronStore.getState().setSelectedJobId('job-123')
    expect(useCronStore.getState().selectedJobId).toBe('job-123')
  })
})

describe('cron helpers', () => {
  it('formatSchedule handles "at" kind', () => {
    expect(formatSchedule({ kind: 'at' })).toBe('One-time')
    expect(formatSchedule({ kind: 'at', at: '2025-01-01T00:00:00Z' })).toContain('One-time')
  })

  it('formatSchedule handles "every" kind', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 30000 })).toBe('Every 30s')
    expect(formatSchedule({ kind: 'every', everyMs: 120000 })).toBe('Every 2 min')
    expect(formatSchedule({ kind: 'every', everyMs: 7200000 })).toBe('Every 2h')
    expect(formatSchedule({ kind: 'every', everyMs: 172800000 })).toBe('Every 2 days')
  })

  it('formatSchedule handles "cron" kind', () => {
    expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *' })).toBe('Cron: 0 9 * * *')
    expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe('Cron: 0 9 * * * (UTC)')
  })

  it('formatSchedule unwraps a one-time job stuffed into cron expr', () => {
    expect(
      formatSchedule({
        kind: 'cron',
        expr: '{"kind":"at","at":"2026-09-09T20:10:30+08:00"}',
      }),
    ).toMatch(/^One-time:/)
  })

  it('getRunStatusColor returns correct colors', () => {
    expect(getRunStatusColor('success')).toBe('text-green-500')
    expect(getRunStatusColor('failed')).toBe('text-red-500')
    expect(getRunStatusColor('timeout')).toBe('text-orange-500')
    expect(getRunStatusColor('running')).toBe('text-blue-500')
    expect(getRunStatusColor('stale')).toBe('text-yellow-500')
  })

  it('getChannelDisplayName returns correct names', () => {
    expect(getChannelDisplayName('discord')).toBe('Discord')
    expect(getChannelDisplayName('feishu')).toBe('Feishu')
    expect(getChannelDisplayName('email')).toBe('Email')
    expect(getChannelDisplayName('kook')).toBe('KOOK')
  })

  it('formatRelativeTime formats past and future times', () => {
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
    const now = new Date()
    const tenSecsAgo = new Date(now.getTime() - 10000).toISOString()
    expect(formatRelativeTime(tenSecsAgo)).toBe(rtf.format(-10, 'second'))

    const fiveMinsAgo = new Date(now.getTime() - 300000).toISOString()
    expect(formatRelativeTime(fiveMinsAgo)).toBe(rtf.format(-5, 'minute'))

    const inTwoHours = new Date(now.getTime() + 2 * 3600 * 1000).toISOString()
    expect(formatRelativeTime(inTwoHours)).toBe(rtf.format(2, 'hour'))
  })
})

// ==================== Extended helper tests ====================

describe('formatSchedule – edge cases', () => {
  it('returns "Interval" when everyMs is missing', () => {
    expect(formatSchedule({ kind: 'every' })).toBe('Interval')
  })

  it('boundary: exactly 60 000 ms rounds to "Every 1 min"', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 60000 })).toBe('Every 1 min')
  })

  it('boundary: exactly 3 600 000 ms rounds to "Every 1h"', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 3600000 })).toBe('Every 1h')
  })

  it('boundary: exactly 86 400 000 ms rounds to "Every 1 days"', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 86400000 })).toBe('Every 1 days')
  })

  it('returns "Cron" when cron expr is missing', () => {
    expect(formatSchedule({ kind: 'cron' })).toBe('Cron')
  })

  it('returns "Cron" with no tz when tz is absent', () => {
    expect(formatSchedule({ kind: 'cron', expr: '*/30 * * * *' })).toBe('Cron: */30 * * * *')
  })

  it('appends timezone when tz is set', () => {
    expect(formatSchedule({ kind: 'cron', expr: '0 18 * * 1-5', tz: 'Asia/Shanghai' })).toBe(
      'Cron: 0 18 * * 1-5 (Asia/Shanghai)',
    )
  })

  it('returns "Unknown" for unrecognised kind', () => {
    // Cast to bypass TypeScript exhaustive check
    expect(formatSchedule({ kind: 'unknown' as any })).toBe('Unknown')
  })
})

describe('formatRelativeTime – extended ranges', () => {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  it('returns "in 1 minute" for a future time less than 60 seconds away', () => {
    const in30s = new Date(Date.now() + 30000).toISOString()
    expect(formatRelativeTime(in30s)).toBe(rtf.format(1, 'minute'))
  })

  it('returns correct future days', () => {
    const in3Days = new Date(Date.now() + 3 * 86400_000).toISOString()
    expect(formatRelativeTime(in3Days)).toBe(rtf.format(3, 'day'))
  })

  it('returns correct future months', () => {
    const in2Months = new Date(Date.now() + 60 * 86400_000).toISOString()
    expect(formatRelativeTime(in2Months)).toBe(rtf.format(2, 'month'))
  })

  it('returns correct future years', () => {
    const in2Years = new Date(Date.now() + 800 * 86400_000).toISOString()
    expect(formatRelativeTime(in2Years)).toBe(rtf.format(2, 'year'))
  })

  it('returns "Just now" for a timestamp less than 1 second ago', () => {
    const veryRecent = new Date(Date.now() - 100).toISOString()
    expect(formatRelativeTime(veryRecent)).toBe('Just now')
  })

  it('returns correct past days', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString()
    expect(formatRelativeTime(twoDaysAgo)).toBe(rtf.format(-2, 'day'))
  })

  it('returns correct past months', () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 86400_000).toISOString()
    expect(formatRelativeTime(twoMonthsAgo)).toBe(rtf.format(-2, 'month'))
  })

  it('returns correct past years', () => {
    const twoYearsAgo = new Date(Date.now() - 800 * 86400_000).toISOString()
    expect(formatRelativeTime(twoYearsAgo)).toBe(rtf.format(-2, 'year'))
  })
})

describe('getRunStatusColor – edge cases', () => {
  it('returns muted color for unknown status', () => {
    expect(getRunStatusColor('unknown' as any)).toBe('text-muted-foreground')
  })
})

describe('normalizeCronRunRecord', () => {
  it('maps legacy success records with timeout cut-short summaries to timeout', () => {
    const record = normalizeCronRunRecord({
      runId: 'run-1',
      jobId: 'job-1',
      startedAt: new Date().toISOString(),
      status: 'success',
      responseSummary: 'partial output\n\n---\n⚠️ AI response was cut short after 180s timeout.',
    })

    expect(record.status).toBe('timeout')
  })
})

describe('getChannelDisplayName – all channels', () => {
  it('returns "WeChat" for wechat', () => {
    expect(getChannelDisplayName('wechat')).toBe('WeChat')
  })

  it('returns "WeCom" for wecom', () => {
    expect(getChannelDisplayName('wecom')).toBe('WeCom')
  })

  it('returns "SeaTalk" for seatalk', () => {
    expect(getChannelDisplayName('seatalk')).toBe('SeaTalk')
  })
})

// ==================== Store action tests ====================

describe('cron store actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCronStore.setState({
      jobs: [],
      isLoading: false,
      error: null,
      isInitialized: false,
      selectedJobId: null,
      runs: [],
      runsLoading: false,
      showCronSessions: false,
      cronSessionIds: new Set(),
    })
  })

  const baseRequest = {
    name: 'My Job',
    enabled: true,
    schedule: { kind: 'cron' as const, expr: '0 9 * * *' },
    payload: { message: 'hello' },
    deleteAfterRun: false,
  }

  const mockJob = {
    id: 'job-1',
    name: 'My Job',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    payload: { message: 'hello' },
    deleteAfterRun: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  it('addJob appends the new job to state', async () => {
    mockInvoke.mockResolvedValueOnce(mockJob)
    const job = await useCronStore.getState().addJob(baseRequest)
    expect(job).toEqual(mockJob)
    expect(useCronStore.getState().jobs).toContainEqual(mockJob)
    expect(mockInvoke).toHaveBeenCalledWith('cron_add_job', {
      request: baseRequest,
      scope: 'global',
      workspacePath: null,
    })
  })

  it('addJob propagates errors', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('create failed'))
    await expect(useCronStore.getState().addJob(baseRequest)).rejects.toThrow('create failed')
    expect(useCronStore.getState().error).toBe('create failed')
  })

  it('updateJob replaces the existing job in state', async () => {
    const updated = { ...mockJob, name: 'Updated Job' }
    useCronStore.setState({ jobs: [mockJob as any] })
    mockInvoke.mockResolvedValueOnce(updated)
    const result = await useCronStore.getState().updateJob({ id: 'job-1', name: 'Updated Job' })
    expect(result.name).toBe('Updated Job')
    expect(useCronStore.getState().jobs[0].name).toBe('Updated Job')
    expect(mockInvoke).toHaveBeenCalledWith('cron_update_job', {
      request: { id: 'job-1', name: 'Updated Job' },
      scope: 'global',
      workspacePath: null,
    })
  })

  it('removeJob removes the job from state', async () => {
    useCronStore.setState({ jobs: [mockJob as any] })
    mockInvoke.mockResolvedValueOnce(undefined)
    await useCronStore.getState().removeJob('job-1')
    expect(useCronStore.getState().jobs).toHaveLength(0)
    expect(mockInvoke).toHaveBeenCalledWith('cron_remove_job', {
      jobId: 'job-1',
      scope: 'global',
      workspacePath: null,
    })
  })

  it('removeJob clears selectedJobId when the removed job was selected', async () => {
    useCronStore.setState({ jobs: [mockJob as any], selectedJobId: 'job-1' })
    mockInvoke.mockResolvedValueOnce(undefined)
    await useCronStore.getState().removeJob('job-1')
    expect(useCronStore.getState().selectedJobId).toBeNull()
  })

  it('toggleEnabled updates the enabled flag in state', async () => {
    useCronStore.setState({ jobs: [{ ...mockJob, enabled: true } as any] })
    mockInvoke.mockResolvedValueOnce(undefined)
    await useCronStore.getState().toggleEnabled('job-1', false)
    expect(useCronStore.getState().jobs[0].enabled).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('cron_toggle_enabled', {
      jobId: 'job-1',
      enabled: false,
      scope: 'global',
      workspacePath: null,
    })
  })

  it('loadRuns populates runs and sets selectedJobId', async () => {
    const runs = [{ runId: 'r1', jobId: 'job-1', startedAt: new Date().toISOString(), status: 'success' }]
    mockInvoke.mockResolvedValueOnce(runs)
    await useCronStore.getState().loadRuns('job-1')
    expect(useCronStore.getState().runs).toEqual(runs)
    expect(useCronStore.getState().selectedJobId).toBe('job-1')
    expect(useCronStore.getState().runsLoading).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('cron_get_runs', {
      jobId: 'job-1',
      limit: 50,
      scope: 'global',
      workspacePath: null,
    })
  })

  it('loadRuns normalizes legacy timeout-success records before storing them', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        runId: 'r1',
        jobId: 'job-1',
        startedAt: new Date().toISOString(),
        status: 'success',
        responseSummary: 'partial output\n\n---\n⚠️ AI response was cut short after 180s timeout.',
      },
    ])

    await useCronStore.getState().loadRuns('job-1')

    expect(useCronStore.getState().runs[0].status).toBe('timeout')
  })

  it('loadJobs sets jobs from backend', async () => {
    useCronStore.setState({ isInitialized: true })
    mockInvoke.mockResolvedValueOnce([mockJob])
    await useCronStore.getState().loadJobs()
    expect(useCronStore.getState().jobs).toEqual([mockJob])
    expect(mockInvoke).toHaveBeenCalledWith('cron_list_jobs', {
      scope: 'global',
      workspacePath: null,
    })
  })

  it('reinit resets initialized flag and reloads jobs', async () => {
    useCronStore.setState({ isInitialized: true })
    mockInvoke.mockResolvedValueOnce(undefined) // cron_init
    mockInvoke.mockResolvedValueOnce([]) // cron_list_jobs
    await useCronStore.getState().reinit()
    expect(useCronStore.getState().isInitialized).toBe(true)
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'cron_init', {
      scope: 'global',
      workspacePath: null,
    })
  })

  it('runJob navigates to the new run session once its id is stamped', async () => {
    vi.useFakeTimers()
    useCronStore.setState({
      isInitialized: true,
      jobs: [{ id: 'job-1', name: 'Test' } as never],
    })
    // Before the run only r0 exists; after cron_run_job the new run r1 shows up
    // with an eagerly-stamped sessionId.
    let ranJob = false
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case 'cron_get_runs':
          return Promise.resolve(
            ranJob
              ? [
                  { runId: 'r1', jobId: 'job-1', startedAt: 't', status: 'running', sessionId: 'sess-new' },
                  { runId: 'r0', jobId: 'job-1', startedAt: 't', status: 'success' },
                ]
              : [{ runId: 'r0', jobId: 'job-1', startedAt: 't', status: 'success' }],
          )
        case 'cron_run_job':
          ranJob = true
          return Promise.resolve(undefined)
        default:
          return Promise.resolve([]) // cron_list_jobs, etc.
      }
    })

    const promise = useCronStore.getState().runJob('job-1')
    expect(useCronStore.getState().runningJobIds.has('job-1')).toBe(true)

    await vi.runAllTimersAsync()
    await promise

    expect(mockInvoke).toHaveBeenCalledWith('cron_run_job', {
      jobId: 'job-1',
      scope: 'global',
      workspacePath: null,
    })
    expect(mockSwitchToSession).toHaveBeenCalledWith('sess-new')
    expect(useCronStore.getState().showCronSessions).toBe(true)
    expect(useCronStore.getState().cronSessionIds.has('sess-new')).toBe(true)
    expect(useCronStore.getState().runningJobIds.has('job-1')).toBe(false)
    vi.useRealTimers()
  })

  it('runJob ignores a run that already existed before the run', async () => {
    vi.useFakeTimers()
    useCronStore.setState({
      isInitialized: true,
      jobs: [{ id: 'job-1', name: 'Test' } as never],
    })
    // Only a prior run (with a session id) exists; it must not be mistaken for
    // this run's session, and no new run ever gets a session id.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'cron_get_runs') {
        return Promise.resolve([
          { runId: 'r0', jobId: 'job-1', startedAt: 't', status: 'success', sessionId: 'sess-old' },
        ])
      }
      return Promise.resolve(undefined)
    })

    const promise = useCronStore.getState().runJob('job-1')
    await vi.runAllTimersAsync()
    await promise

    expect(mockSwitchToSession).not.toHaveBeenCalled()
    expect(useCronStore.getState().runningJobIds.has('job-1')).toBe(false)
    vi.useRealTimers()
  })

  it('runJob ignores duplicate triggers while already running', async () => {
    vi.useFakeTimers()
    useCronStore.setState({ isInitialized: true })
    mockInvoke.mockResolvedValue([])

    const first = useCronStore.getState().runJob('job-1')
    // Second call while the first is still running must be a no-op.
    await useCronStore.getState().runJob('job-1')

    await vi.runAllTimersAsync()
    await first

    // cron_run_job fired exactly once despite two runJob calls.
    const runCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'cron_run_job')
    expect(runCalls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('refreshDelivery invokes cron_refresh_delivery', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await useCronStore.getState().refreshDelivery()
    expect(mockInvoke).toHaveBeenCalledWith('cron_refresh_delivery')
  })

  it('toggleShowCronSessions flips the flag', () => {
    expect(useCronStore.getState().showCronSessions).toBe(false)
    useCronStore.getState().toggleShowCronSessions()
    expect(useCronStore.getState().showCronSessions).toBe(true)
    useCronStore.getState().toggleShowCronSessions()
    expect(useCronStore.getState().showCronSessions).toBe(false)
  })

  it('setShowCronSessions sets the clock-only session list state explicitly', () => {
    useCronStore.getState().setShowCronSessions(true)
    expect(useCronStore.getState().showCronSessions).toBe(true)
    useCronStore.getState().setShowCronSessions(false)
    expect(useCronStore.getState().showCronSessions).toBe(false)
  })
})
