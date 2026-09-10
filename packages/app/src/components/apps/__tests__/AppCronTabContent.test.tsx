import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppCronTabContent } from '../AppCronTabContent'
import type { AppCronJob, AppRow } from '@/lib/backend/types'

const backendMocks = vi.hoisted(() => ({
  listAppCronJobs: vi.fn(),
  listAppAccess: vi.fn(),
  createAppCronJob: vi.fn(),
  updateAppCronJob: vi.fn(),
  deleteAppCronJob: vi.fn(),
  runAppCronJobNow: vi.fn(),
  listAppCronRuns: vi.fn(),
}))

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))

const storeMocks = vi.hoisted(() => ({ items: [] as AppRow[] }))

vi.mock('@/lib/backend', () => ({ getBackend: () => ({ apps: backendMocks }) }))
vi.mock('sonner', () => ({ toast: toastMocks }))
vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (sel: (s: typeof storeMocks) => unknown) => sel(storeMocks),
}))
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, string>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) text = text.replace(`{{${k}}}`, String(v))
      }
      return text
    },
  }),
}))

const app = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo App',
} as unknown as AppRow

const job = (over: Partial<AppCronJob> = {}): AppCronJob => ({
  id: 'job-1',
  appId: 'app-1',
  name: 'Daily report',
  enabled: true,
  schedule: '0 9 * * *',
  timezone: 'UTC',
  method: 'POST',
  path: '/api/daily',
  headers: {},
  body: null,
  timeoutMs: 30000,
  lastRunAt: null,
  nextRunAt: '2099-01-01T09:00:00.000Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

function renderTab() {
  storeMocks.items = [app]
  return render(<AppCronTabContent appId="app-1" />)
}

describe('AppCronTabContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    backendMocks.listAppCronJobs.mockResolvedValue([job()])
    backendMocks.listAppAccess.mockResolvedValue([])
    backendMocks.listAppCronRuns.mockResolvedValue([])
  })

  it('lists a task with its schedule and where it points', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Daily report')).toBeTruthy())
    expect(screen.getByText('POST /api/daily')).toBeTruthy()
    expect(screen.getByText(/0 9 \* \* \* · UTC/)).toBeTruthy()
  })

  it('says an enabled task will never fire rather than showing a blank time', async () => {
    // nextRunAt is null on an enabled job only when the expression names a date
    // that does not exist. Rendering nothing there would read as "any moment".
    backendMocks.listAppCronJobs.mockResolvedValue([job({ nextRunAt: null })])
    renderTab()
    await waitFor(() => expect(screen.getByText(/永远不会到/)).toBeTruthy())
  })

  it('shows a disabled task as off, not as never', async () => {
    backendMocks.listAppCronJobs.mockResolvedValue([job({ enabled: false, nextRunAt: null })])
    renderTab()
    await waitFor(() => expect(screen.getByText('已停用')).toBeTruthy())
  })

  it('hides every write control from a member who cannot manage', async () => {
    backendMocks.listAppAccess.mockResolvedValue(null)
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-cron-readonly')).toBeTruthy())
    expect(screen.queryByTestId('app-cron-new')).toBeNull()
    expect(screen.queryByTestId('app-cron-run-now')).toBeNull()
  })

  it('surfaces the failure reason from a manual run', async () => {
    // That text is what names the login wall and the tab that fixes it, so it
    // must reach the user rather than being flattened to "failed".
    backendMocks.runAppCronJobNow.mockResolvedValue({
      jobId: 'job-1',
      status: 'failed',
      responseStatus: 302,
      error: '该路径需要登录，而定时任务没有会话。',
    })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-cron-run-now')).toBeTruthy())
    await userEvent.setup().click(screen.getByTestId('app-cron-run-now'))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalled())
    expect(toastMocks.error.mock.calls[0][1]).toEqual({
      description: '该路径需要登录，而定时任务没有会话。',
    })
  })

  it('does not move the schedule when a run is triggered by hand', async () => {
    backendMocks.runAppCronJobNow.mockResolvedValue({
      jobId: 'job-1',
      status: 'success',
      responseStatus: 200,
      error: null,
    })
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-cron-run-now')).toBeTruthy())
    await userEvent.setup().click(screen.getByTestId('app-cron-run-now'))

    await waitFor(() => expect(backendMocks.runAppCronJobNow).toHaveBeenCalledWith('app-1', 'job-1'))
    expect(backendMocks.updateAppCronJob).not.toHaveBeenCalled()
  })

  it('creates a task from the dialog, parsing headers a line at a time', async () => {
    backendMocks.listAppCronJobs.mockResolvedValue([])
    backendMocks.createAppCronJob.mockResolvedValue(job({ id: 'job-2' }))
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-cron-new')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-cron-new'))
    await user.type(screen.getByPlaceholderText('每天生成日报'), 'Nightly')
    await user.clear(screen.getByTestId('app-cron-path'))
    await user.type(screen.getByTestId('app-cron-path'), '/api/nightly')
    await user.type(screen.getByPlaceholderText('X-Job-Secret: ...'), 'X-Job-Secret: hunter2')
    await user.click(screen.getByTestId('app-cron-save'))

    await waitFor(() => expect(backendMocks.createAppCronJob).toHaveBeenCalled())
    const [appId, input] = backendMocks.createAppCronJob.mock.calls[0]
    expect(appId).toBe('app-1')
    expect(input.name).toBe('Nightly')
    expect(input.path).toBe('/api/nightly')
    expect(input.headers).toEqual({ 'X-Job-Secret': 'hunter2' })
  })

  it('will not save a path that is a whole URL', async () => {
    // An absolute URL would make a scheduled task an outbound request machine
    // pointed anywhere; the server refuses it too, this just says so sooner.
    backendMocks.listAppCronJobs.mockResolvedValue([])
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-cron-new')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-cron-new'))
    await user.type(screen.getByPlaceholderText('每天生成日报'), 'Nightly')
    await user.clear(screen.getByTestId('app-cron-path'))
    await user.type(screen.getByTestId('app-cron-path'), 'https://evil.example.com/')

    expect(screen.getByTestId('app-cron-save')).toHaveProperty('disabled', true)
    expect(screen.getByText(/只填路径/)).toBeTruthy()
  })

  it('will not save headers that are not `Name: value`', async () => {
    backendMocks.listAppCronJobs.mockResolvedValue([])
    renderTab()
    await waitFor(() => expect(screen.getByTestId('app-cron-new')).toBeTruthy())

    const user = userEvent.setup()
    await user.click(screen.getByTestId('app-cron-new'))
    await user.type(screen.getByPlaceholderText('每天生成日报'), 'Nightly')
    await user.type(screen.getByPlaceholderText('X-Job-Secret: ...'), 'not a header')

    expect(screen.getByTestId('app-cron-save')).toHaveProperty('disabled', true)
  })
})
