import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { appRelationship } from '@/lib/apps/app-relationship'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { useMyMemberActorId } from '@/stores/app-relationship-filter'
import type { AppRow } from '@/lib/backend/types'

/** The word for one app, and what hovering it says. */
export interface AppRelationshipLabel {
  label: string
  /** Who invited me — only the invited case has anything to add. */
  hint: string | null
}

/**
 * One vocabulary for both app lists.
 *
 * The sidebar and the library each used to name the relationship their own
 * way: the sidebar said 我的 under the icon while the library marked the same
 * app 团队 — because its badge read `visibility`, and "shared with the team" and
 * "someone else's team app" had ended up sharing a word. The quick-filter chips
 * settle which meaning 团队 carries, so the badge now comes from the same place
 * the chips do.
 */
export function useAppRelationshipLabel(): (app: AppRow) => AppRelationshipLabel {
  const { t } = useTranslation()
  const { actors } = useActorDirectory()
  const myActorId = useMyMemberActorId()

  return React.useCallback(
    (app: AppRow) => {
      const relationship = appRelationship(app, myActorId)
      if (relationship === 'owner') return { label: t('apps.relationshipOwner', '我的'), hint: null }
      if (relationship === 'team') return { label: t('apps.relationshipTeam', '团队'), hint: null }
      const inviter = app.invitedByActorId
        ? actors.find((a) => a.id === app.invitedByActorId)?.display_name
        : null
      return {
        label: t('apps.relationshipInvited', '受邀'),
        hint: inviter ? t('apps.relationshipInvitedBy', '{{name}} 邀请', { name: inviter }) : null,
      }
    },
    [actors, myActorId, t],
  )
}
