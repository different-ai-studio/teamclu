import { useCurrentTeamStore } from '@/stores/current-team'

type CloudRole = 'owner' | 'admin' | 'member'

interface TeamPermissions {
  /** Highest cloud membership role among owner|admin|member. null = finance-only / unknown / no team. */
  role: CloudRole | null
  /** Most sensitive gates: enable team-share, configure team-shared model. */
  isOwner: boolean
  /** Team management: env vars, shared-secret deletion, etc. (old owner/manager). */
  canManageTeam: boolean
  /** File editing. Members are read-only; owner/admin/finance and solo/no-team can edit. */
  canEditFiles: boolean
}

export interface RemovableActorTarget {
  id: string
  actor_type?: 'member' | 'agent' | string
  visibility?: string | null
  owner_member_id?: string | null
}

/** Whether the signed-in member may remove another actor from the team. */
export function canRemoveTeamActor(
  permissions: Pick<TeamPermissions, 'canManageTeam'>,
  target: RemovableActorTarget,
  currentMemberId: string | null | undefined,
): boolean {
  if (!currentMemberId) return false
  if (target.id === currentMemberId) return false

  if (target.actor_type === 'agent') {
    if (target.visibility === 'personal') {
      return currentMemberId === target.owner_member_id
    }
    if (target.visibility === 'team') {
      return permissions.canManageTeam
    }
    // Unknown visibility (e.g. cold cache before network reconcile): hide delete.
    return false
  }

  return permissions.canManageTeam
}

/** Highest privilege among owner|admin|member (finance is not a CloudRole). */
export function highestRoleCode(roles: Array<{ code: string }>): CloudRole | null {
  const codes = new Set(roles.map((r) => (r.code ?? '').toLowerCase()))
  if (codes.has('owner')) return 'owner'
  if (codes.has('admin')) return 'admin'
  if (codes.has('member')) return 'member'
  return null
}

/**
 * Derive UI permissions from org role assignments.
 * Finance alone → canEditFiles true, canManageTeam false.
 * Member-only → read-only files. Empty/null → solo (edit allowed, manage denied).
 */
export function permissionsForRoles(
  roles: Array<{ code: string }> | null | undefined,
): TeamPermissions {
  if (roles == null || roles.length === 0) {
    return { role: null, isOwner: false, canManageTeam: false, canEditFiles: true }
  }

  const codes = roles.map((r) => (r.code ?? '').toLowerCase())
  const role = highestRoleCode(roles)
  const canManageTeam = codes.includes('owner') || codes.includes('admin')
  // Only pure member assignments are file-read-only; finance (and unknowns) can edit.
  const isOnlyMember = codes.every((c) => c === 'member')

  return {
    role,
    isOwner: role === 'owner',
    canManageTeam,
    canEditFiles: !isOnlyMember,
  }
}

/** React hook: the single source of truth for team permissions (cloud roles). */
export function useTeamPermissions(): TeamPermissions {
  const member = useCurrentTeamStore((s) => s.currentMember)
  if (member?.roles != null && member.roles.length > 0) {
    return permissionsForRoles(member.roles)
  }
  // Rollout fallback: legacy single `role` string when `roles[]` is absent.
  return permissionsForRoles(member?.role ? [{ code: member.role }] : null)
}
