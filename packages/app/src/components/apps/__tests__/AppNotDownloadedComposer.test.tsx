import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppNotDownloadedComposer } from '../AppNotDownloadedComposer'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts
      const fallback = opts?.defaultValue
      if (typeof fallback !== 'string') return key
      return fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''))
    },
  }),
}))

const app = {
  id: 'app-1',
  teamId: 'team-1',
  name: 'Alpha',
  slug: 'alpha',
  type: 'static_web',
  visibility: 'personal',
  workspaceId: null,
  gitRemoteUrl: null,
  gitAuthKind: null,
  provisionStatus: 'ready',
  fcStatus: null,
  fcEndpoint: null,
  publicUrl: null,
  authMode: 'none',
  runtime: 'node',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as AppRow

describe('AppNotDownloadedComposer', () => {
  beforeEach(() => {
    useAppsStore.setState({ download: vi.fn().mockResolvedValue(undefined) })
  })

  it('names the app that is missing', () => {
    // Which one, not just "an app": the session list mixes app sessions with
    // ordinary ones and the title bar does not say.
    render(<AppNotDownloadedComposer app={app} />)
    expect(screen.getByTestId('app-not-downloaded-composer')).toHaveTextContent('Alpha')
  })

  it('offers the download, and that is the only action', () => {
    render(<AppNotDownloadedComposer app={app} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(useAppsStore.getState().download).toHaveBeenCalledWith(app)
  })

  it('does not fire twice while one download is in flight', () => {
    const download = vi.fn(() => new Promise<void>(() => {}))
    useAppsStore.setState({ download })
    render(<AppNotDownloadedComposer app={app} />)
    const button = screen.getByRole('button')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(download).toHaveBeenCalledTimes(1)
  })
})
