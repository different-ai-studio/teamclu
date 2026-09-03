import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }))

const mockSelectShortcuts = vi.fn()
const mockRpcCreate       = vi.fn()
const mockRpcUpdate       = vi.fn()
const mockRpcDelete       = vi.fn()
const mockRpcBatchMove    = vi.fn()
vi.mock('@/lib/daemon/shortcuts-rpc', () => ({
  selectShortcuts:     (...a: unknown[]) => mockSelectShortcuts(...a),
  rpcShortcutCreate:   (...a: unknown[]) => mockRpcCreate(...a),
  rpcShortcutUpdate:   (...a: unknown[]) => mockRpcUpdate(...a),
  rpcShortcutDelete:   (...a: unknown[]) => mockRpcDelete(...a),
  rpcShortcutBatchMove:(...a: unknown[]) => mockRpcBatchMove(...a),
  ShortcutsRpcError: class extends Error {},
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/ws' }) },
}))

import { useShortcutsStore } from '@/stores/shortcuts'

beforeEach(() => {
  vi.clearAllMocks()
  useShortcutsStore.setState({
    personalNodes: [],
    teamNodes: [],
    loading: false,
    loadedAt: null,
    teamRoles: null,
    shortcutVisibility: null,
  })
})

describe('useShortcutsStore', () => {
  it('loadPersonal fetches via selectShortcuts without persisting by default', async () => {
    mockSelectShortcuts.mockResolvedValue([
      { id: 'a', scope: 'personal', label: 'A', type: 'link', target: 't', parentId: null,
        order: 0, ownerMemberId: 'm', teamId: null, icon: null, createdAt: '', updatedAt: '' },
    ])
    mockInvoke.mockResolvedValue(undefined)
    await useShortcutsStore.getState().loadPersonal()
    expect(useShortcutsStore.getState().personalNodes).toHaveLength(1)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('loadPersonal persists cache when persist option is set', async () => {
    mockSelectShortcuts.mockResolvedValue([
      { id: 'a', scope: 'personal', label: 'A', type: 'link', target: 't', parentId: null,
        order: 0, ownerMemberId: 'm', teamId: null, icon: null, createdAt: '', updatedAt: '' },
    ])
    mockInvoke.mockResolvedValue(undefined)
    await useShortcutsStore.getState().loadPersonal({ persist: true })
    expect(mockInvoke).toHaveBeenCalledWith('save_shortcuts', expect.objectContaining({
      workspacePath: '/ws',
      nodes: expect.any(Array),
    }))
  })

  it('addNode calls rpcShortcutCreate then re-fetches the affected scope', async () => {
    mockRpcCreate.mockResolvedValue('new-id')
    mockSelectShortcuts.mockResolvedValue([])
    mockInvoke.mockResolvedValue(undefined)
    const id = await useShortcutsStore.getState().addNode('personal', {
      label: 'L', type: 'link', target: 't', parentId: null, icon: null, order: 0,
    })
    expect(id).toBe('new-id')
    expect(mockRpcCreate).toHaveBeenCalledOnce()
    expect(mockSelectShortcuts).toHaveBeenCalledWith({ scope: 'personal' })
  })

  it('addNode does not update state on RPC failure', async () => {
    mockRpcCreate.mockRejectedValue(new Error('forbidden'))
    await expect(useShortcutsStore.getState().addNode('team', {
      label: 'L', type: 'link', target: 't', parentId: null, icon: null, order: 0,
    })).rejects.toThrow('forbidden')
    expect(useShortcutsStore.getState().teamNodes).toHaveLength(0)
  })

  it('deleteNode calls rpcShortcutDelete then re-fetches', async () => {
    mockRpcDelete.mockResolvedValue(undefined)
    mockSelectShortcuts.mockResolvedValue([])
    useShortcutsStore.setState({
      personalNodes: [{ id: 'a', scope: 'personal', label: 'A', type: 'link', target: 't',
        parentId: null, order: 0, ownerMemberId: 'm', teamId: null, icon: null,
        createdAt: '', updatedAt: '' }],
    })
    await useShortcutsStore.getState().deleteNode('a')
    expect(mockRpcDelete).toHaveBeenCalledWith('a')
    expect(mockSelectShortcuts).toHaveBeenCalled()
  })

  it('batchMove calls rpcShortcutBatchMove and re-fetches', async () => {
    mockRpcBatchMove.mockResolvedValue(2)
    mockSelectShortcuts.mockResolvedValue([])
    await useShortcutsStore.getState().batchMove([
      { id: 'a', parentId: null, order: 0 },
      { id: 'b', parentId: 'a',  order: 1 },
    ])
    expect(mockRpcBatchMove).toHaveBeenCalledOnce()
  })

  it('getTree returns personal + team trees combined', () => {
    useShortcutsStore.setState({
      personalNodes: [
        { id: 'p1', scope: 'personal', label: 'P1', type: 'link', target: 't', parentId: null,
          order: 0, ownerMemberId: 'm', teamId: null, icon: null, createdAt: '', updatedAt: '' },
      ],
      teamNodes: [
        { id: 't1', scope: 'team', label: 'T1', type: 'link', target: 't', parentId: null,
          order: 0, ownerMemberId: null, teamId: 'team-1', icon: null, createdAt: '', updatedAt: '' },
      ],
    })
    expect(useShortcutsStore.getState().getTree()).toHaveLength(2)
  })

  it('on launch cache hydration: loads cache via load_shortcuts before network', async () => {
    mockInvoke.mockResolvedValueOnce([
      { id: 'cache-id', scope: 'personal', label: 'Cached', node_type: 'link', target: 't',
        parent_id: null, order: 0, owner_member_id: 'm', team_id: null, icon: null,
        created_at: '', updated_at: '' },
    ])
    await useShortcutsStore.getState().hydrateFromCache()
    expect(useShortcutsStore.getState().personalNodes).toHaveLength(1)
    expect(useShortcutsStore.getState().personalNodes[0].label).toBe('Cached')
  })
})
