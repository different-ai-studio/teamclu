import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppHeaderActions } from '../AppSessionsColumn'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

const shellOpen = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpen }))

const reveal = vi.hoisted(() => vi.fn())
vi.mock('@/components/workspace/file-tree-operations', () => ({ revealInFinder: reveal }))

const workdir = vi.hoisted(() => vi.fn(async () => '/tmp/app-1'))
vi.mock('@/lib/app-session', () => ({
  appWorkdirPath: workdir,
  createAppSessionShell: vi.fn(),
  openAppSession: vi.fn(),
}))

const app = (over: Partial<AppRow> = {}): AppRow =>
  ({
    id: 'app-1',
    teamId: 'team-1',
    name: 'Alpha',
    slug: 'alpha',
    type: 'fullstack_tanstack_postgres',
    visibility: 'personal',
    workspaceId: null,
    gitRemoteUrl: null,
    gitAuthKind: null,
    gitCommitSha: null,
    runtime: 'node',
    authMode: 'none',
    authModePendingRedeploy: false,
    oauthClientId: null,
    provisionStatus: 'ready',
    fcStatus: null,
    fcEndpoint: null,
    fcFunctionName: null,
    fcRegion: null,
    publicUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as AppRow

const deploy = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useAppsStore.setState({ deployingIds: [], deploy } as never)
})

describe('AppHeaderActions', () => {
  it('shows one trigger, not a row of icons', async () => {
    // The whole point of the move: the 280px header has room for a name plus
    // two controls, not a name plus four.
    render(<AppHeaderActions app={app()} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByTestId('app-header-actions')).toBeInTheDocument()
  })

  it('deploys the app the header belongs to', async () => {
    render(<AppHeaderActions app={app()} />)
    await userEvent.click(screen.getByTestId('app-header-actions'))
    await userEvent.click(await screen.findByText('部署'))
    expect(deploy).toHaveBeenCalledWith('app-1')
  })

  it('keeps a blocked deploy visible and says why, instead of hiding it', async () => {
    // A missing entry reads as "this app can never be deployed"; a disabled one
    // with the reason underneath names the setting to change.
    render(<AppHeaderActions app={app({ authMode: 'third' })} />)
    await userEvent.click(screen.getByTestId('app-header-actions'))
    const item = await screen.findByText('部署')
    expect(item.closest('[role="menuitem"]')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/第三方登录尚未支持部署/)).toBeInTheDocument()
  })

  it('disables opening the URL until the app is actually live', async () => {
    render(<AppHeaderActions app={app({ fcStatus: 'deploy_error', fcEndpoint: null })} />)
    await userEvent.click(screen.getByTestId('app-header-actions'))
    const item = (await screen.findByText('打开部署地址')).closest('[role="menuitem"]')
    expect(item).toHaveAttribute('aria-disabled', 'true')

    await userEvent.keyboard('{Escape}')
    render(<AppHeaderActions app={app({ fcStatus: 'live', fcEndpoint: 'https://x.fcapp.run' })} />)
    const triggers = screen.getAllByTestId('app-header-actions')
    await userEvent.click(triggers[triggers.length - 1])
    await userEvent.click(await screen.findByText('打开部署地址'))
    expect(shellOpen).toHaveBeenCalledWith('https://x.fcapp.run')
  })

  it('reveals the workdir of this app', async () => {
    render(<AppHeaderActions app={app()} />)
    await userEvent.click(screen.getByTestId('app-header-actions'))
    await userEvent.click(await screen.findByText('在 Finder 打开目录'))
    expect(workdir).toHaveBeenCalledWith('app-1', 'team-1')
    expect(reveal).toHaveBeenCalledWith('/tmp/app-1')
  })

  it('shows deploy progress on the trigger, so it is visible with the menu shut', () => {
    useAppsStore.setState({ deployingIds: ['app-1'], deploy } as never)
    const { container } = render(<AppHeaderActions app={app()} />)
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })
})
