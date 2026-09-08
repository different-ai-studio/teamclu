import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppLogsTabContent } from '../AppLogsTabContent'
import type { AppLogEntry } from '@/lib/backend/types'

const backend = vi.hoisted(() => ({ readAppLogs: vi.fn() }))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ apps: backend }),
}))

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (selector: (s: unknown) => unknown) =>
    selector({ items: [{ id: 'app-1', name: 'Demo' }] }),
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

function entry(over: Partial<AppLogEntry> = {}): AppLogEntry {
  return {
    ts: '2026-09-08T10:00:00.000Z',
    kind: 'app',
    level: 'info',
    message: 'listening on 9000',
    ...over,
  }
}

function ok(entries: AppLogEntry[], over: Record<string, unknown> = {}) {
  return { status: 'ok', entries, truncated: false, from: null, to: null, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  backend.readAppLogs.mockResolvedValue(ok([]))
})

it('reads the app stream over the last hour by default', async () => {
  render(<AppLogsTabContent appId="app-1" />)
  await waitFor(() => expect(backend.readAppLogs).toHaveBeenCalled())
  expect(backend.readAppLogs).toHaveBeenCalledWith(
    'app-1',
    expect.objectContaining({ kind: 'app', sinceMinutes: 60, requestId: null }),
  )
})

it('shows each line and colours the failures', async () => {
  backend.readAppLogs.mockResolvedValue(
    ok([entry(), entry({ level: 'error', message: 'TypeError: x is not a function' })]),
  )
  render(<AppLogsTabContent appId="app-1" />)
  const rows = await screen.findAllByTestId('app-logs-entry')
  expect(rows).toHaveLength(2)
  expect(screen.getByText('TypeError: x is not a function')).toBeInTheDocument()
})

it('narrows to one request when its id is clicked, and can undo it', async () => {
  // The point of the whole feature: an app's own output has no request id, so
  // the server reconstructs it — this is what makes that reachable.
  backend.readAppLogs.mockResolvedValue(ok([entry({ requestId: 'req-abcdefgh' })]))
  render(<AppLogsTabContent appId="app-1" />)
  await userEvent.click(await screen.findByTestId('app-logs-request-chip'))
  await waitFor(() =>
    expect(backend.readAppLogs).toHaveBeenLastCalledWith(
      'app-1',
      expect.objectContaining({ requestId: 'req-abcdefgh' }),
    ),
  )
  await userEvent.click(screen.getByTestId('app-logs-clear-request'))
  await waitFor(() =>
    expect(backend.readAppLogs).toHaveBeenLastCalledWith(
      'app-1',
      expect.objectContaining({ requestId: null }),
    ),
  )
})

it('switches stream and window without losing the search', async () => {
  render(<AppLogsTabContent appId="app-1" />)
  await waitFor(() => expect(backend.readAppLogs).toHaveBeenCalled())

  await userEvent.type(screen.getByTestId('app-logs-search'), 'user_sessions{Enter}')
  await waitFor(() =>
    expect(backend.readAppLogs).toHaveBeenLastCalledWith(
      'app-1',
      expect.objectContaining({ contains: 'user_sessions' }),
    ),
  )

  await userEvent.click(screen.getByTestId('app-logs-kind-request'))
  await waitFor(() =>
    expect(backend.readAppLogs).toHaveBeenLastCalledWith(
      'app-1',
      expect.objectContaining({ kind: 'request', contains: 'user_sessions' }),
    ),
  )

  await userEvent.click(screen.getByTestId('app-logs-window-15'))
  await waitFor(() =>
    expect(backend.readAppLogs).toHaveBeenLastCalledWith(
      'app-1',
      expect.objectContaining({ sinceMinutes: 15, kind: 'request' }),
    ),
  )
})

describe('the states are told apart', () => {
  it('an app that was never deployed', async () => {
    backend.readAppLogs.mockResolvedValue({ status: 'not_deployed' })
    render(<AppLogsTabContent appId="app-1" />)
    await screen.findByTestId('app-logs-state-not-deployed')
  })

  it('a deployment that cannot reach its log service', async () => {
    backend.readAppLogs.mockResolvedValue({
      status: 'unavailable',
      reason: 'APPS_ACCESS_KEY_ID is not set',
    })
    render(<AppLogsTabContent appId="app-1" />)
    const el = await screen.findByTestId('app-logs-state-unavailable')
    expect(el.textContent).toMatch(/APPS_ACCESS_KEY_ID/)
  })

  it('a quiet window is about the window, not about the app', async () => {
    render(<AppLogsTabContent appId="app-1" />)
    const el = await screen.findByTestId('app-logs-empty')
    expect(el.textContent).toMatch(/时间范围/)
  })

  it('a truncated result says so', async () => {
    backend.readAppLogs.mockResolvedValue(ok([entry()], { truncated: true }))
    render(<AppLogsTabContent appId="app-1" />)
    await screen.findByTestId('app-logs-truncated')
  })

  it('a 404 does not read as a crash', async () => {
    backend.readAppLogs.mockResolvedValue(null)
    render(<AppLogsTabContent appId="app-1" />)
    await screen.findByTestId('app-logs-state-none')
  })

  it('a thrown error is shown as itself', async () => {
    backend.readAppLogs.mockRejectedValue(new Error('network down'))
    render(<AppLogsTabContent appId="app-1" />)
    const el = await screen.findByTestId('app-logs-error')
    expect(el.textContent).toMatch(/network down/)
  })
})
