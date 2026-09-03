import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockShortcuts = vi.hoisted(() => ({
  listShortcuts: vi.fn(),
  createShortcut: vi.fn(),
  updateShortcut: vi.fn(),
  deleteShortcut: vi.fn(),
  batchMove: vi.fn(),
  setVisibleRoles: vi.fn(),
  listTeamRoles: vi.fn(),
  listShortcutRoleBindings: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ shortcuts: mockShortcuts }),
}))

import {
  rpcShortcutCreate,
  rpcShortcutBatchMove,
  rpcShortcutSetVisibleRoles,
  selectShortcuts,
  ShortcutsRpcError,
} from '@/lib/daemon/shortcuts-rpc'

beforeEach(() => {
  for (const fn of Object.values(mockShortcuts)) fn.mockReset()
})

describe('rpcShortcutCreate', () => {
  it('calls shortcut_create RPC with named args for personal scope', async () => {
    mockShortcuts.createShortcut.mockResolvedValue({ id: 'new-uuid' })
    const id = await rpcShortcutCreate({
      scope: 'personal',
      label: 'My Link',
      nodeType: 'link',
      parentId: null,
      icon: null,
      order: 0,
      target: 'https://example.com',
    })
    expect(id).toBe('new-uuid')
    expect(mockShortcuts.createShortcut).toHaveBeenCalledWith({
      p_scope: 'personal',
      p_label: 'My Link',
      p_node_type: 'link',
      p_team_id: null,
      p_parent_id: null,
      p_icon: null,
      p_order: 0,
      p_target: 'https://example.com',
    })
  })

  it('throws ShortcutsRpcError when RPC errors', async () => {
    mockShortcuts.createShortcut.mockRejectedValue({ message: 'forbidden', code: 'P0001' })
    await expect(rpcShortcutCreate({
      scope: 'team',
      teamId: 'team-uuid',
      label: 'L',
      nodeType: 'link',
      parentId: null,
      icon: null,
      order: 0,
      target: '',
    })).rejects.toThrow(ShortcutsRpcError)
  })
})

describe('rpcShortcutBatchMove', () => {
  it('sends jsonb-shaped moves array', async () => {
    mockShortcuts.batchMove.mockResolvedValue(3)
    const count = await rpcShortcutBatchMove([
      { id: 'a', parentId: null, order: 0 },
      { id: 'b', parentId: 'a',  order: 1 },
    ])
    expect(count).toBe(3)
    expect(mockShortcuts.batchMove).toHaveBeenCalledWith({
      p_moves: [
        { id: 'a', parent_id: null, order: 0 },
        { id: 'b', parent_id: 'a',  order: 1 },
      ],
    })
  })
})

describe('rpcShortcutSetVisibleRoles', () => {
  it('forwards shortcut_id and role_ids', async () => {
    mockShortcuts.setVisibleRoles.mockResolvedValue(undefined)
    await rpcShortcutSetVisibleRoles('shortcut-uuid', ['role-1', 'role-2'])
    expect(mockShortcuts.setVisibleRoles).toHaveBeenCalledWith({
      p_shortcut_id: 'shortcut-uuid',
      p_role_ids: ['role-1', 'role-2'],
    })
  })
})

describe('selectShortcuts', () => {
  it('queries shortcuts by scope and maps DB rows to ShortcutNode', async () => {
    mockShortcuts.listShortcuts.mockResolvedValue([{
      id: 'a', scope: 'personal', owner_member_id: 'm1', team_id: null,
      parent_id: null, label: 'L', icon: null, order: 0,
      node_type: 'link', target: 't', created_at: '2026-01-01', updated_at: '2026-01-01',
    }])
    const rows = await selectShortcuts({ scope: 'personal' })
    expect(mockShortcuts.listShortcuts).toHaveBeenCalledWith('personal', undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'a', label: 'L', type: 'link', target: 't', parentId: null, order: 0,
    })
  })
})
