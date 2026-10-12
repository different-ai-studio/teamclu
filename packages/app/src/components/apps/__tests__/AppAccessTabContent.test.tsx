import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { AppAccessTabContent } from '../AppAccessTabContent'
import type { AppRow } from '@/lib/backend/types'

const app = { id: 'app-1', teamId: 'team-1', name: 'Demo App' } as AppRow
const backend = vi.hoisted(() => ({ listAppAccess: vi.fn(), setAppAccess: vi.fn() }))
const members = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('@/lib/backend', () => ({ getBackend: () => ({ apps: backend }) }))
vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  listTeamMembersForAccess: members.list,
}))
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
    members.list.mockResolvedValue([
      { id: 'a', displayName: '朱昊勤', role: 'member' },
      { id: 'b', displayName: '钱小磊', role: 'member' },
      { id: 'c', displayName: '朱晓明', role: 'member' },
    ])
    backend.setAppAccess.mockImplementation(async (_appId: string, memberId: string) => ({
      memberId,
      permissionLevel: 'prompt',
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
    await waitFor(() => expect(backend.setAppAccess).toHaveBeenCalledWith('app-1', 'c', 'prompt'))
  })
})
