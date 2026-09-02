import { useCurrentTeamStore } from '@/stores/current-team'

type CloudRole = 'owner' | 'admin' | 'member'

interface TeamPermissions {
  /** Cloud membership role, normalized. null = no cloud team / not yet loaded. */
  role: CloudRole | null
  /** Most sensitive gates: enable team-share, configure team-shared model. */
  isOwner: boolean
  /** Team management: env vars, shared-secret deletion, etc. (old owner/manager). */
  canManageTeam: boolean
  /** File editing. Members are read-only; owner/admin and solo/no-team can edit. */
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

export function permissionsForRole(role: string | null | undefined): TeamPermissions {
  const normalized = (role ?? '').toLowerCase()
  const r: CloudRole | null =
    normalized === 'owner' || normalized === 'admin' || normalized === 'member'
      ? (normalized as CloudRole)
      : null
  return {
    role: r,
    isOwner: r === 'owner',
    canManageTeam: r === 'owner' || r === 'admin',
    canEditFiles: r !== 'member',
  }
}

/** React hook: the single source of truth for team permissions (cloud role). */
export function useTeamPermissions(): TeamPermissions {
  const role = useCurrentTeamStore((s) => s.currentMember?.role ?? null)
  return permissionsForRole(role)
}
