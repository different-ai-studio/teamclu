import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ShortcutNode } from '@/stores/shortcuts'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))
vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded', open: true, setOpen: () => {}, toggleSidebar: () => {} }),
}))
vi.mock('@/components/app-sidebar', () => ({ SidebarCollapseToggle: () => null }))
vi.mock('@/components/ui/traffic-lights', () => ({ TrafficLights: () => null }))
vi.mock('@/components/icons/LucideIconByName', () => ({ LucideIconByName: () => null }))

import { ShortcutsListColumn, filterShortcutTree } from '../ShortcutsListColumn'
import { useShortcutsStore, buildTree } from '@/stores/shortcuts'
import { useCurrentTeamStore } from '@/stores/current-team'

const node = (id: string, label: string, over: Partial<ShortcutNode> = {}): ShortcutNode =>
  ({ id, label, type: 'link', target: `https://x/${id}`, parentId: null, icon: null, order: 0, ...over }) as ShortcutNode

const NODES = [
  node('f1', '运营', { type: 'folder', target: '' }),
  node('l1', '日报看板', { parentId: 'f1' }),
  node('l2', '门店巡检', { parentId: 'f1', order: 1 }),
  node('l3', '财务后台'),
]

describe('ShortcutsListColumn', () => {
  beforeEach(() => {
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useShortcutsStore.setState({
      personalNodes: NODES,
      teamNodes: [],
      loadTeamForCurrentTeam: vi.fn(async () => {}),
    } as never)
  })

  it('starts with folders collapsed, and opens one on click', () => {
    render(<ShortcutsListColumn />)
    expect(screen.getByText('运营')).toBeInTheDocument()
    expect(screen.queryByText('日报看板')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('运营'))
    expect(screen.getByText('日报看板')).toBeInTheDocument()
  })

  it('searches, opening the folders that hold a match, and has no refresh button', () => {
    render(<ShortcutsListColumn />)
    expect(screen.queryByTitle('Refresh Team Shortcuts')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByLabelText('搜索快捷方式'), { target: { value: '巡检' } })
    expect(screen.getByText('门店巡检')).toBeInTheDocument()
    expect(screen.queryByText('日报看板')).not.toBeInTheDocument()
    expect(screen.queryByText('财务后台')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索快捷方式'), { target: { value: '没有' } })
    expect(screen.getByText('没有匹配的快捷方式')).toBeInTheDocument()
  })

  it('reloads the team shortcuts when it opens', () => {
    render(<ShortcutsListColumn />)
    expect(useShortcutsStore.getState().loadTeamForCurrentTeam).toHaveBeenCalledWith('team-1')
  })
})

describe('filterShortcutTree', () => {
  it('keeps a matching folder whole', () => {
    const tree = filterShortcutTree(buildTree(NODES, null), '运营')
    expect(tree.map((n) => n.label)).toEqual(['运营'])
    expect(tree[0].children?.map((n) => n.label)).toEqual(['日报看板', '门店巡检'])
  })
})
