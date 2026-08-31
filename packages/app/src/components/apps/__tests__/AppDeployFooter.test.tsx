import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppDeployFooter } from '../AppDeployFooter'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

const openAppPreview = vi.hoisted(() => vi.fn())
vi.mock('@/lib/tabs/app-tabs', () => ({
  openAppPreview: (...args: unknown[]) => openAppPreview(...args),
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
  useAppsStore.setState({
    deployingIds: [],
    deployProgressByAppId: {},
    deploy,
  } as never)
})

describe('AppDeployFooter', () => {
  it('deploys from the footer', async () => {
    render(<AppDeployFooter app={app()} />)
    await userEvent.click(screen.getByTestId('app-deploy-footer-deploy'))
    expect(deploy).toHaveBeenCalledWith('app-1')
  })

  it('opens preview in a webview tab when live', async () => {
    render(
      <AppDeployFooter
        app={app({ fcStatus: 'live', fcEndpoint: 'https://x.fcapp.run' })}
      />,
    )
    await userEvent.click(screen.getByTestId('app-deploy-footer-preview'))
    expect(openAppPreview).toHaveBeenCalled()
  })

  it('shows progress while deploying', async () => {
    useAppsStore.setState({
      deployingIds: ['app-1'],
      deployProgressByAppId: { 'app-1': { phase: 'build', startedAt: Date.now() } },
      deploy,
    } as never)
    const { container } = render(<AppDeployFooter app={app()} />)
    expect(screen.getByTestId('app-deploy-footer')).toBeInTheDocument()
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
    expect(screen.getByText('部署中…')).toBeInTheDocument()
  })

  it('shows why deploy is blocked', () => {
    render(<AppDeployFooter app={app({ authMode: 'third' })} />)
    expect(screen.getByText(/第三方登录尚未支持部署/)).toBeInTheDocument()
    expect(screen.getByTestId('app-deploy-footer-deploy')).toBeDisabled()
  })
})
