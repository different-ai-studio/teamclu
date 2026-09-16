import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Star, User as UserIcon, UserMinus } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import type { ActorRow } from '@/stores/actor-directory-store'
import { cn } from '@/lib/utils'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { canRemoveTeamActor, useTeamPermissions } from '@/lib/team/team-permissions'

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
 * default agent / Remove-from-team items.
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
  const setDefaultAgent = useMemberPreferencesStore((s) => s.setDefaultAgent)
  const onToggleDefault = React.useCallback(() => {
    if (!teamId) return
    void setDefaultAgent(teamId, isDefault ? null : actor.id).catch((e) => {
      console.error('[ActorContextMenu] set default agent failed', e)
    })
  }, [teamId, isDefault, actor.id, setDefaultAgent])

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
