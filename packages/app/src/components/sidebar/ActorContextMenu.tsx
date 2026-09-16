import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Shield, ShieldOff, Star, User as UserIcon, UserMinus } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import type { ActorRow } from '@/stores/actor-directory-store'
import { patchMemberTeamRole, useActorDirectoryStore } from '@/stores/actor-directory-store'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { formatSetTeamMemberRoleError } from '@/lib/actor/actor-set-role-error'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  canRemoveTeamActor,
  canSetTeamMemberRole,
  effectiveTeamRole,
  nextTeamMemberRole,
  useTeamPermissions,
} from '@/lib/team/team-permissions'

interface Props {
  actor: ActorRow
  /** True when this actor is the current user's default agent. */
  isDefault?: boolean
  onViewDetail: (actor: ActorRow) => void
  onCopyName: (actor: ActorRow) => void
  onCopyId: (actor: ActorRow) => void
  onRequestRemove: (actor: ActorRow) => void
  /**
   * Extra menu items rendered (with a leading separator) just before the
   * destructive "Remove from team" item. Used by the local-daemon row to add a
   * "Settings" entry that other actors don't have.
   */
  extraItems?: React.ReactNode
  /** The row element the menu is attached to (rendered via `asChild`). */
  children: React.ReactNode
}

/**
 * Shared right-click menu for any actor row (recents, the local-daemon row,
 * etc.) so every actor exposes the same actions. Wraps its `children` (the row
 * trigger) and renders the View profile / Copy name / Copy ID / Set-or-remove
 * default agent / Set-or-remove admin / Remove-from-team items.
 */
export function ActorContextMenu({
  actor,
  isDefault = false,
  onViewDetail,
  onCopyName,
  onCopyId,
  onRequestRemove,
  extraItems,
  children,
}: Props) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMemberId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)
  const teamPermissions = useTeamPermissions()
  const canRemove = canRemoveTeamActor(teamPermissions, actor, currentMemberId)
  const canChangeRole = canSetTeamMemberRole(teamPermissions, actor, currentMemberId)
  const nextRole = canChangeRole ? nextTeamMemberRole(effectiveTeamRole(actor)) : null
  const setDefaultAgent = useMemberPreferencesStore((s) => s.setDefaultAgent)
  const onToggleDefault = React.useCallback(() => {
    if (!teamId) return
    void setDefaultAgent(teamId, isDefault ? null : actor.id).catch((e) => {
      console.error('[ActorContextMenu] set default agent failed', e)
    })
  }, [teamId, isDefault, actor.id, setDefaultAgent])

  const onToggleAdmin = React.useCallback(() => {
    if (!teamId || !nextRole) return
    void (async () => {
      try {
        await getBackend().teams.setTeamMemberRole(teamId, actor.id, nextRole)
        patchMemberTeamRole(teamId, actor.id, nextRole)
        void useActorDirectoryStore.getState().refetch(teamId)
        toast.success(
          nextRole === 'admin'
            ? t('actors.roleChanged.setAdmin', '{{name}} is now an admin', {
                name: actor.display_name,
              })
            : t('actors.roleChanged.removeAdmin', '{{name}} is no longer an admin', {
                name: actor.display_name,
              }),
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(formatSetTeamMemberRoleError(msg, t))
      }
    })()
  }, [teamId, nextRole, actor.id, actor.display_name, t])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => onViewDetail(actor)}>
          <UserIcon className="h-4 w-4" />
          {t('actors.contextMenu.viewProfile', 'View profile')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopyName(actor)}>
          <Copy className="h-4 w-4" />
          {t('actors.contextMenu.copyName', 'Copy name')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopyId(actor)}>
          <Copy className="h-4 w-4" />
          {t('actors.contextMenu.copyId', 'Copy ID')}
        </ContextMenuItem>
        {isAgent && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onToggleDefault} disabled={!teamId}>
              <Star className={cn('h-4 w-4', isDefault && 'fill-current')} />
              {isDefault
                ? t('actors.contextMenu.removeDefault', 'Remove as default agent')
                : t('actors.contextMenu.setDefault', 'Set as default agent')}
            </ContextMenuItem>
          </>
        )}
        {nextRole && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onToggleAdmin} disabled={!teamId}>
              {nextRole === 'admin' ? (
                <Shield className="h-4 w-4" />
              ) : (
                <ShieldOff className="h-4 w-4" />
              )}
              {nextRole === 'admin'
                ? t('actors.contextMenu.setAdmin', 'Set as admin')
                : t('actors.contextMenu.removeAdmin', 'Remove admin')}
            </ContextMenuItem>
          </>
        )}
        {extraItems && (
          <>
            <ContextMenuSeparator />
            {extraItems}
          </>
        )}
        {canRemove && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onRequestRemove(actor)}>
              <UserMinus className="h-4 w-4" />
              {t('actors.contextMenu.remove', 'Remove from team')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
