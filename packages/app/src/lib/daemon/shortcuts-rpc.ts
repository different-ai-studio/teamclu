import { getBackend } from '@/lib/backend'

export type ShortcutScope = 'personal' | 'team'
export type ShortcutNodeType = 'native' | 'link' | 'folder'

export interface ShortcutNode {
  id: string
  scope: ShortcutScope
  ownerMemberId: string | null
  teamId: string | null
  parentId: string | null
  label: string
  icon: string | null
  order: number
  type: ShortcutNodeType
  target: string
  createdAt: string
  updatedAt: string
  children?: ShortcutNode[]
}

export interface TeamRole {
  id: string
  teamId: string
  code: string
  name: string
}

export class ShortcutsRpcError extends Error {
  constructor(public readonly code: string | null, message: string) {
    super(message)
    this.name = 'ShortcutsRpcError'
  }
}

function asShortcutsRpcError(error: unknown): ShortcutsRpcError {
  if (error instanceof ShortcutsRpcError) return error
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {}
  const code = typeof record.code === 'string' ? record.code : null
  const message =
    typeof record.message === 'string' && record.message.trim() !== ''
      ? record.message
      : error instanceof Error
        ? error.message
        : 'Shortcuts RPC failed'
  return new ShortcutsRpcError(code, message)
}

function rowToNode(row: Record<string, unknown>): ShortcutNode {
  return {
    id:            row.id as string,
    scope:         row.scope as ShortcutScope,
    ownerMemberId: (row.owner_member_id as string | null) ?? null,
    teamId:        (row.team_id as string | null) ?? null,
    parentId:      (row.parent_id as string | null) ?? null,
    label:         row.label as string,
    icon:          (row.icon as string | null) ?? null,
    order:         row.order as number,
    type:          row.node_type as ShortcutNodeType,
    target:        (row.target as string) ?? '',
    createdAt:     row.created_at as string,
    updatedAt:     row.updated_at as string,
  }
}

export async function selectShortcuts(opts: {
  scope: ShortcutScope
  teamId?: string
}): Promise<ShortcutNode[]> {
  try {
    const rows = await getBackend().shortcuts.listShortcuts(opts.scope, opts.teamId)
    return rows.map(row => rowToNode(row as unknown as Record<string, unknown>))
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}

interface ShortcutCreateInput {
  scope: ShortcutScope
  teamId?: string
  label: string
  nodeType: ShortcutNodeType
  parentId: string | null
  icon: string | null
  order: number
  target: string
}

export async function rpcShortcutCreate(input: ShortcutCreateInput): Promise<string> {
  try {
    const row = await getBackend().shortcuts.createShortcut({
      p_scope:     input.scope,
      p_label:     input.label,
      p_node_type: input.nodeType,
      p_team_id:   input.scope === 'team' ? (input.teamId ?? null) : null,
      p_parent_id: input.parentId,
      p_icon:      input.icon,
      p_order:     input.order,
      p_target:    input.target,
    })
    return row.id
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}

export async function rpcShortcutUpdate(
  id: string,
  patch: Partial<Pick<ShortcutNode, 'label' | 'icon' | 'target' | 'order' | 'parentId'>>,
): Promise<void> {
  const dbPatch: Record<string, unknown> = {}
  if (patch.label    !== undefined) dbPatch.label     = patch.label
  if (patch.icon     !== undefined) dbPatch.icon      = patch.icon
  if (patch.target   !== undefined) dbPatch.target    = patch.target
  if (patch.order    !== undefined) dbPatch.order     = patch.order
  if (patch.parentId !== undefined) dbPatch.parent_id = patch.parentId
  dbPatch.updated_at = new Date().toISOString()
  try {
    await getBackend().shortcuts.updateShortcut(id, dbPatch)
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}

export async function rpcShortcutDelete(id: string): Promise<void> {
  try {
    await getBackend().shortcuts.deleteShortcut(id)
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}

interface ShortcutMove {
  id: string
  parentId: string | null
  order: number
}

export async function rpcShortcutBatchMove(moves: ShortcutMove[]): Promise<number> {
  try {
    const result = await getBackend().shortcuts.batchMove({
      p_moves: moves.map(m => ({ id: m.id, parent_id: m.parentId, order: m.order })),
    })
    return result as number
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}

export async function rpcShortcutSetVisibleRoles(
  shortcutId: string,
  roleIds: string[],
): Promise<void> {
  try {
    await getBackend().shortcuts.setVisibleRoles({
      p_shortcut_id: shortcutId,
      p_role_ids: roleIds,
    })
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}

export async function selectTeamRoles(teamId: string): Promise<TeamRole[]> {
  try {
    const rows = await getBackend().shortcuts.listTeamRoles(teamId)
    return rows.map(r => ({ id: r.id, teamId: r.team_id, code: r.code, name: r.name }))
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}

export async function selectShortcutRoleBindings(teamId: string): Promise<Map<string, string[]>> {
  try {
    const data = await getBackend().shortcuts.listShortcutRoleBindings(teamId)
    const m = new Map<string, string[]>()
    for (const p of data) {
      m.set(p.resource_id, p.permission_roles.map(pr => pr.role_id))
    }
    return m
  } catch (error) {
    throw asShortcutsRpcError(error)
  }
}
