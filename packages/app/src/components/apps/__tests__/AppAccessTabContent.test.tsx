import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppAccessTabContent } from '../AppAccessTabContent'
import type { AppRow } from '@/lib/backend/types'

const app = { id: 'app-1', teamId: 'team-1', name: 'Demo App', createdByActorId: 'owner' } as AppRow
const backend = vi.hoisted(() => ({ listAppAccess: vi.fn(), setAppAccess: vi.fn() }))
const actors = vi.hoisted(() => ({ listTeamActorsForAppAccess: vi.fn() }))

vi.mock('@/lib/backend', () => ({ getBackend: () => ({ apps: backend, actors }) }))
vi.mock('@/stores/apps-store', () => ({
  useAppsStore: (select: (store: { items: AppRow[]; invalidateAppSummary: () => void }) => unknown) =>
    select({ items: [app], invalidateAppSummary: vi.fn() }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

describe('AppAccessTabContent member picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend.listAppAccess.mockResolvedValue([])
    actors.listTeamActorsForAppAccess.mockResolvedValue([
      { id: 'agent-1', displayName: '小助手', actorType: 'agent', connected: true },
      { id: 'agent-2', displayName: '离线助手', actorType: 'agent', connected: false },
      { id: 'owner', displayName: '创建者', actorType: 'member', connected: true },
      { id: 'a', displayName: '朱昊勤', actorType: 'member', connected: true },
      { id: 'b', displayName: '钱小磊', actorType: 'member', connected: true },
      { id: 'c', displayName: '朱晓明', actorType: 'member', connected: true },
    ])
    backend.setAppAccess.mockImplementation(async (_appId: string, memberId: string, level: string) => ({
      memberId,
      permissionLevel: level,
    }))
  })

  it('filters available members by name and grants the selected match', async () => {
    const user = userEvent.setup()
    render(<AppAccessTabContent appId="app-1" />)

    const picker = await screen.findByTestId('app-access-member-picker')
    await user.click(picker)
    const search = screen.getByPlaceholderText('搜索成员…')
    await user.type(search, '没有此人')
    expect(screen.getByText('没有匹配的成员')).toBeInTheDocument()
    await user.clear(search)
    await user.type(search, '朱')

    const list = screen.getByRole('dialog')
    expect(within(list).getByText('朱昊勤')).toBeInTheDocument()
    expect(within(list).getByText('朱晓明')).toBeInTheDocument()
    expect(within(list).queryByText('钱小磊')).not.toBeInTheDocument()

    await user.click(within(list).getByText('朱晓明'))
    await user.click(screen.getByTestId('app-access-grant'))
    // The default level is write (it was "prompt" before the rename).
    await waitFor(() => expect(backend.setAppAccess).toHaveBeenCalledWith('app-1', 'c', 'write'))
  })

  it('never offers the app creator, and greys out an agent that is not connected', async () => {
    const user = userEvent.setup()
    render(<AppAccessTabContent appId="app-1" />)

    await user.click(await screen.findByTestId('app-access-member-picker'))
    const list = screen.getByRole('dialog')
    expect(within(list).queryByText('创建者')).not.toBeInTheDocument()
    const offline = within(list).getByText('离线助手').closest('[cmdk-item]')
    expect(offline).toHaveAttribute('aria-disabled', 'true')
  })

  it('grants write to a connected agent in one click', async () => {
    const user = userEvent.setup()
    render(<AppAccessTabContent appId="app-1" />)

    const quick = await screen.findByTestId('app-access-quick-agents')
    expect(within(quick).queryByText('离线助手')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('app-access-quick-grant-agent-1'))
    await waitFor(() => expect(backend.setAppAccess).toHaveBeenCalledWith('app-1', 'agent-1', 'write'))
    // Once granted, the agent leaves the quick list and shows up as a grantee.
    await waitFor(() => expect(screen.queryByTestId('app-access-quick-agents')).not.toBeInTheDocument())
  })

  it('marks an agent grantee with a badge', async () => {
    backend.listAppAccess.mockResolvedValue([
      { memberId: 'agent-1', permissionLevel: 'read', grantedByMemberId: 'owner', createdAt: '2026-11-17T00:00:00Z', actorType: 'agent', connected: true },
    ])
    render(<AppAccessTabContent appId="app-1" />)
    const tab = await screen.findByTestId('app-access-tab')
    const row = within(tab).getByText('小助手').closest('li')!
    expect(within(row).getByText('agent')).toBeInTheDocument()
  })
})
