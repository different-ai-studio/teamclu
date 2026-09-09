import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppLogsSection } from '../AppLogsSection'
import type { AppRow } from '@/lib/backend/types'

const openAppLogs = vi.hoisted(() => vi.fn())

vi.mock('@/lib/tabs/app-tabs', () => ({
  openAppLogs: (...args: unknown[]) => openAppLogs(...args),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, unknown>) => {
      let text = fallback ?? key
      if (opts) {
        for (const [k, v] of Object.entries(opts)) text = text.replace(`{{${k}}}`, String(v))
      }
      return text
    },
  }),
}))

const APP = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Demo',
  slug: 'demo',
  type: 'fullstack_tanstack_postgres',
  visibility: 'team',
  workspaceId: null,
  gitRemoteUrl: null,
  gitAuthKind: null,
  gitCommitSha: null,
  runtime: 'node',
  authMode: 'none',
  authModePendingRedeploy: false,
  oauthClientId: null,
  provisionStatus: 'ready',
  fcStatus: 'live',
  fcEndpoint: 'https://x.fcapp.run',
  fcFunctionName: 'tc-app-1',
  fcRegion: 'cn-shenzhen',
  publicUrl: null,
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z',
} as AppRow

beforeEach(() => {
  vi.clearAllMocks()
})

it('opens the logs tab for this app', async () => {
  render(<AppLogsSection app={APP} />)
  await userEvent.click(screen.getByTestId('app-logs-open'))
  expect(openAppLogs).toHaveBeenCalledWith(APP, '日志')
})

it('offers no entry for an app that was never deployed', () => {
  // There is nothing to open: Function Compute keeps no logs for a function
  // that does not exist yet, and a button that always answers "empty" reads as
  // a broken feature.
  render(<AppLogsSection app={{ ...APP, fcStatus: null } as AppRow} />)
  expect(screen.queryByTestId('app-logs-open')).not.toBeInTheDocument()
  screen.getByTestId('app-logs-state-not-deployed')
})

it('offers the entry for an app whose last deploy failed', () => {
  // `deploy_error` is exactly when the logs are worth reading — the function
  // may well be live on its previous code, and the failure is in them.
  render(<AppLogsSection app={{ ...APP, fcStatus: 'deploy_error' } as AppRow} />)
  screen.getByTestId('app-logs-open')
})

it('makes no request to render', () => {
  // The panel re-renders on every app selection; whether logs can exist at all
  // is already on the row.
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  render(<AppLogsSection app={APP} />)
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
})
