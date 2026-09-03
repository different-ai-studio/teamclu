import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import {
  selectShortcuts,
  rpcShortcutCreate,
  rpcShortcutUpdate,
  rpcShortcutDelete,
  rpcShortcutBatchMove,
  rpcShortcutSetVisibleRoles,
  selectTeamRoles,
  selectShortcutRoleBindings,
  type ShortcutNode,
  type ShortcutScope,
  type ShortcutNodeType,
  type TeamRole,
} from '@/lib/daemon/shortcuts-rpc'
import { useWorkspaceStore } from './workspace'

export type { ShortcutNode, TeamRole } from '@/lib/daemon/shortcuts-rpc'

interface NewShortcutInput {
  label: string
  type: ShortcutNodeType
  target: string
  parentId: string | null
  icon: string | null
  order: number
}

interface ShortcutsState {
  personalNodes: ShortcutNode[]
  teamNodes: ShortcutNode[]
  loading: boolean
  loadedAt: number | null

  teamRoles: TeamRole[] | null
  shortcutVisibility: Map<string, string[]> | null

  loadPersonal: (options?: { persist?: boolean }) => Promise<void>
  loadTeamForCurrentTeam: (teamId: string | null, options?: { persist?: boolean }) => Promise<void>
  hydrateFromCache: () => Promise<void>

  addNode:    (scope: ShortcutScope, input: NewShortcutInput, teamId?: string) => Promise<string>
  updateNode: (id: string, patch: Partial<Pick<ShortcutNode,'label'|'icon'|'target'|'order'|'parentId'>>) => Promise<void>
  deleteNode: (id: string) => Promise<void>
  batchMove:  (moves: Array<{ id: string; parentId: string | null; order: number }>) => Promise<void>

  loadTeamRoles:    (teamId: string) => Promise<void>
  setVisibleRoles:  (shortcutId: string, roleIds: string[]) => Promise<void>

  getTree: () => ShortcutNode[]
  getChildren: (parentId: string | null) => ShortcutNode[]
}

// ── Cache helpers (Tauri-backed JSON file, version 2) ──────────────────

const CACHE_VERSION = 2

function getWorkspaceArgs(): { workspacePath?: string } {
  const wp = useWorkspaceStore.getState().workspacePath
  return wp ? { workspacePath: wp } : {}
}

interface CacheRow {
  id: string
  scope: ShortcutScope
  owner_member_id: string | null
  team_id: string | null
  parent_id: string | null
  label: string
  icon: string | null
  order: number
  node_type: ShortcutNodeType
  target: string
  created_at: string
  updated_at: string
  __version?: number
}

function nodeToCache(n: ShortcutNode): CacheRow {
  return {
    id: n.id,
    scope: n.scope,
    owner_member_id: n.ownerMemberId,
    team_id: n.teamId,
    parent_id: n.parentId,
    label: n.label,
    icon: n.icon,
    order: n.order,
    node_type: n.type,
    target: n.target,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    __version: CACHE_VERSION,
  }
}

function cacheToNode(r: CacheRow): ShortcutNode {
  return {
    id: r.id,
    scope: r.scope,
    ownerMemberId: r.owner_member_id,
    teamId: r.team_id,
    parentId: r.parent_id,
    label: r.label,
    icon: r.icon,
    order: r.order,
    type: r.node_type,
    target: r.target,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

async function persistCache(nodes: ShortcutNode[]): Promise<void> {
  try {
    await invoke('save_shortcuts', {
      ...getWorkspaceArgs(),
      nodes: nodes.map(nodeToCache),
    })
  } catch { /* best-effort */ }
}

async function readCache(): Promise<ShortcutNode[]> {
  try {
    const raw = await invoke<CacheRow[]>('load_shortcuts', getWorkspaceArgs())
    if (!Array.isArray(raw)) return []
    // Drop rows that look like legacy v1 (no `scope` field) — clean break.
    return raw.filter(r => r && (r as { scope?: unknown }).scope).map(cacheToNode)
  } catch {
    return []
  }
}

// ── Tree helpers ───────────────────────────────────────────────────────

export function buildTree(nodes: ShortcutNode[], parentId: string | null): ShortcutNode[] {
  return nodes
    .filter(n => n.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map(n => ({ ...n, children: buildTree(nodes, n.id) }))
}

// ── Store ──────────────────────────────────────────────────────────────

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  personalNodes: [],
  teamNodes: [],
  loading: false,
  loadedAt: null,
  teamRoles: null,
  shortcutVisibility: null,

  hydrateFromCache: async () => {
    const cached = await readCache()
    if (cached.length === 0) return
    set({
      personalNodes: cached.filter(n => n.scope === 'personal'),
      teamNodes:     cached.filter(n => n.scope === 'team'),
    })
  },

  loadPersonal: async (options?: { persist?: boolean }) => {
    set({ loading: true })
    try {
      const rows = await selectShortcuts({ scope: 'personal' })
      set({ personalNodes: rows, loadedAt: Date.now() })
      if (options?.persist) {
        await persistCache([...rows, ...get().teamNodes])
      }
    } finally {
      set({ loading: false })
    }
  },

  loadTeamForCurrentTeam: async (teamId, options?: { persist?: boolean }) => {
    if (!teamId) { set({ teamNodes: [] }); return }
    set({ loading: true })
    try {
      const rows = await selectShortcuts({ scope: 'team', teamId })
      set({ teamNodes: rows, loadedAt: Date.now() })
      if (options?.persist) {
        await persistCache([...get().personalNodes, ...rows])
      }
    } finally {
      set({ loading: false })
    }
  },

  addNode: async (scope, input, teamId) => {
    const id = await rpcShortcutCreate({
      scope,
      teamId: scope === 'team' ? teamId : undefined,
      label: input.label,
      nodeType: input.type,
      parentId: input.parentId,
      icon: input.icon,
      order: input.order,
      target: input.target,
    })
    if (scope === 'personal') await get().loadPersonal({ persist: true })
    else                       await get().loadTeamForCurrentTeam(teamId ?? null, { persist: true })
    return id
  },

  updateNode: async (id, patch) => {
    await rpcShortcutUpdate(id, patch)
    const node = [...get().personalNodes, ...get().teamNodes].find(n => n.id === id)
    if (node?.scope === 'personal') await get().loadPersonal({ persist: true })
    else if (node?.scope === 'team') await get().loadTeamForCurrentTeam(node.teamId, { persist: true })
  },

  deleteNode: async (id) => {
    const node = [...get().personalNodes, ...get().teamNodes].find(n => n.id === id)
    await rpcShortcutDelete(id)
    if (node?.scope === 'personal') await get().loadPersonal({ persist: true })
    else if (node?.scope === 'team') await get().loadTeamForCurrentTeam(node.teamId, { persist: true })
  },

  batchMove: async (moves) => {
    await rpcShortcutBatchMove(moves)
    // After a batch move we don't know which scope was touched; refresh both.
    await get().loadPersonal({ persist: true })
    const teamId = get().teamNodes[0]?.teamId ?? null
    if (teamId) await get().loadTeamForCurrentTeam(teamId, { persist: true })
  },

  loadTeamRoles: async (teamId) => {
    const [roles, bindings] = await Promise.all([
      selectTeamRoles(teamId),
      selectShortcutRoleBindings(teamId),
    ])
    set({ teamRoles: roles, shortcutVisibility: bindings })
  },

  setVisibleRoles: async (shortcutId, roleIds) => {
    await rpcShortcutSetVisibleRoles(shortcutId, roleIds)
    const teamId = get().teamNodes.find(n => n.id === shortcutId)?.teamId ?? null
    if (teamId) await get().loadTeamRoles(teamId)
  },

  getTree: () => {
    const personal = buildTree(get().personalNodes, null)
    const team     = buildTree(get().teamNodes, null)
    return [...personal, ...team]
  },

  getChildren: (parentId) => {
    const all = [...get().personalNodes, ...get().teamNodes]
    return all.filter(n => n.parentId === parentId).sort((a, b) => a.order - b.order)
  },
}))
