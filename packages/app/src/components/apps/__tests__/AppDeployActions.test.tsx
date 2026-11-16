import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppDeployActions } from '../AppDeployActions'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

const openAppPreview = vi.hoisted(() => vi.fn())
vi.mock('@/lib/tabs/app-tabs', () => ({
  openAppPreview: (...args: unknown[]) => openAppPreview(...args),
}))

const requestAgentDeploy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apps/app-deploy-prompt', () => ({
  requestAgentDeploy: (...args: unknown[]) => requestAgentDeploy(...args),
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

beforeEach(() => {
  vi.clearAllMocks()
  deployment.getApp.mockResolvedValue(null)
  deployment.undeployApp.mockResolvedValue(true)
  requestAgentDeploy.mockResolvedValue('session-1')
  useAppsStore.setState({
    deployingIds: [],
    undeployApp: deployment.undeployApp,
    refreshApp: deployment.refreshApp,
    syncApp: deployment.syncApp,
  } as never)
})

describe('AppDeployActions', () => {
  it('asks the agent to deploy instead of calling the deploy API', async () => {
    const a = app()
    render(<AppDeployActions app={a} />)
    await userEvent.click(screen.getByTestId('app-deploy-actions-deploy'))
    expect(requestAgentDeploy).toHaveBeenCalledWith(a)
  })

  it('opens preview in a webview tab when live', async () => {
    render(
      <AppDeployActions
        app={app({ fcStatus: 'live', fcEndpoint: 'https://x.fcapp.run' })}
      />,
    )
    await userEvent.click(screen.getByTestId('app-deploy-actions-preview'))
    expect(openAppPreview).toHaveBeenCalled()
  })

  it('shows a deploy in flight from the server status', () => {
    render(<AppDeployActions app={app({ fcStatus: 'building' })} />)
    expect(screen.getByText('部署中…')).toBeInTheDocument()
    expect(screen.getByTestId('app-deploy-actions-deploy')).toBeDisabled()
  })

  it('does not deploy an app that is not provisioned yet', () => {
    render(<AppDeployActions app={app({ provisionStatus: 'provisioning' })} />)
    expect(screen.getByTestId('app-deploy-actions-deploy')).toBeDisabled()
  })

  it('shows why deploy is blocked', () => {
    render(<AppDeployActions app={app({ authMode: 'third' })} />)
    expect(screen.getByText(/第三方登录尚未支持部署/)).toBeInTheDocument()
    expect(screen.getByTestId('app-deploy-actions-deploy')).toBeDisabled()
  })

  it('lets a live container app deploy again', () => {
    // The row carries `container` only because a deploy wrote it there, so a
    // gate on that field disabled the button on every app that had just
    // deployed successfully — the first deploy passed, no second one could.
    render(
      <AppDeployActions
        app={app({ runtime: 'container', fcStatus: 'live', fcEndpoint: 'https://fc.example' })}
      />,
    )
    expect(screen.getByTestId('app-deploy-actions-deploy')).toBeEnabled()
  })
})

it('requires confirmation for the uninstall and lets cancellation leave the app live', async () => {
  const live = app({ fcStatus: 'live', canManageDeployment: true })
  deployment.getApp.mockResolvedValue(live)
  render(<AppDeployActions app={live} />)
  await userEvent.click(await screen.findByRole('button', { name: '卸载部署' }))
  expect(deployment.undeployApp).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(deployment.undeployApp).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '卸载部署' }))
  await userEvent.click(screen.getByRole('button', { name: '确认卸载' }))
  expect(deployment.undeployApp).toHaveBeenCalledWith('app-1')
})
it('does not offer a uninstall to a visitor', () => {
  render(<AppDeployActions app={app({ fcStatus: 'live', canManageDeployment: false })} />)
  expect(screen.queryByRole('button', { name: '卸载部署' })).toBeNull()
})

it('blocks uninstall while the server reports a deploy in progress', async () => {
  const building = app({ fcStatus: 'building', canManageDeployment: true })
  deployment.getApp.mockResolvedValue(building)
  render(<AppDeployActions app={building} />)
  expect(await screen.findByRole('button', { name: '卸载部署' })).toBeDisabled()
})

it('loads server management permission before offering uninstall', async () => {
  const live = app({ fcStatus: 'live' })
  deployment.getApp.mockResolvedValue({ ...live, canManageDeployment: true })
  render(<AppDeployActions app={live} />)
  expect(await screen.findByRole('button', { name: '卸载部署' })).toBeEnabled()
})

it('shows one uninstall progress state without an extra action or failure hint', async () => {
  const running = app({ fcStatus: 'uninstalling', canManageDeployment: true })
  deployment.getApp.mockResolvedValue(running)
  render(<AppDeployActions app={running} />)
  expect(await screen.findByRole('status')).toHaveTextContent('卸载中…')
  expect(screen.queryByRole('button', { name: '卸载部署' })).toBeNull()
  expect(screen.getByTestId('app-deploy-actions')).not.toHaveTextContent('第三方登录尚未支持部署')
})

it('shows retry and one cleanup failure state', async () => {
  const failed = app({ fcStatus: 'uninstall_failed', canManageDeployment: true })
  deployment.getApp.mockResolvedValue(failed)
  render(<AppDeployActions app={failed} />)
  expect(await screen.findByRole('button', { name: '重试清理' })).toBeEnabled()
  expect(screen.getByRole('status')).toHaveTextContent('清理未完成')
  expect(screen.getByTestId('app-deploy-actions')).not.toHaveTextContent('第三方登录尚未支持部署')
})
