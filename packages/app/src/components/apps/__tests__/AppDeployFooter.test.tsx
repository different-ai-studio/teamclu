import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const deployment = vi.hoisted(() => ({ getApp: vi.fn(), undeployApp: vi.fn(), refreshApp: vi.fn(), syncApp: vi.fn() }))
vi.mock('@/lib/backend/provider', () => ({ getBackend: () => ({ apps: { getApp: deployment.getApp } }) }))
const deploy = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  deployment.getApp.mockResolvedValue(null)
  deployment.undeployApp.mockResolvedValue(true)
  useAppsStore.setState({
    deployingIds: [],
    deployProgressByAppId: {},
    deploy,
    undeployApp: deployment.undeployApp,
    refreshApp: deployment.refreshApp,
    syncApp: deployment.syncApp,
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

  it('lets a live container app deploy again', () => {
    // The row carries `container` only because a deploy wrote it there, so a
    // gate on that field disabled the button on every app that had just
    // deployed successfully — the first deploy passed, no second one could.
    render(
      <AppDeployFooter
        app={app({ runtime: 'container', fcStatus: 'live', fcEndpoint: 'https://fc.example' })}
      />,
    )
    expect(screen.getByTestId('app-deploy-footer-deploy')).toBeEnabled()
  })
})

it('requires confirmation for the footer uninstall and lets cancellation leave the app live', async () => {
  const live = app({ fcStatus: 'live', canManageDeployment: true })
  deployment.getApp.mockResolvedValue(live)
  render(<AppDeployFooter app={live} />)
  await userEvent.click(await screen.findByRole('button', { name: '卸载部署' }))
  expect(deployment.undeployApp).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(deployment.undeployApp).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '卸载部署' }))
  await userEvent.click(screen.getByRole('button', { name: '确认卸载' }))
  expect(deployment.undeployApp).toHaveBeenCalledWith('app-1')
})
it('does not offer a footer uninstall to a visitor', () => {
  render(<AppDeployFooter app={app({ fcStatus: 'live', canManageDeployment: false })} />)
  expect(screen.queryByRole('button', { name: '卸载部署' })).toBeNull()
})

it('blocks footer uninstall while a deploy has started but its live row is not yet updated', async () => {
  const live = app({ fcStatus: 'live', canManageDeployment: true })
  deployment.getApp.mockResolvedValue(live)
  useAppsStore.setState({ deployingIds: ['app-1'] })
  render(<AppDeployFooter app={live} />)
  expect(await screen.findByRole('button', { name: '卸载部署' })).toBeDisabled()
})

it('loads server management permission before offering footer uninstall', async () => {
  const live = app({ fcStatus: 'live' })
  deployment.getApp.mockResolvedValue({ ...live, canManageDeployment: true })
  render(<AppDeployFooter app={live} />)
  expect(await screen.findByRole('button', { name: '卸载部署' })).toBeEnabled()
})
