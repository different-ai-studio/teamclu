import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ActorRow } from '@/stores/actor-directory-store'
import { ActorDetailContent } from './ActorDetailContent'

interface Props {
  actor: ActorRow | null
  teamId?: string | null
  onOpenChange: (open: boolean) => void
  /** Called after a successful admin remove so directory lists can refresh. */
  onRemoved?: () => void
}

/**
 * Actor profile as a modal. Used where there is no main column to hand the
 * profile to — the left sidebar's recents rows and the local-daemon row.
 * Contacts in column 2 uses `ActorsDetailColumn` in the main column instead.
 */
export function ActorDetailDialog({ actor, teamId, onOpenChange, onRemoved }: Props) {
  const { t } = useTranslation()
  // Keep the last actor rendered through the close animation: `actor` goes null
  // the moment the caller clears its selection, and an empty dialog would flash.
  const lastActorRef = React.useRef<ActorRow | null>(null)
  if (actor) lastActorRef.current = actor
  const displayActor = actor ?? lastActorRef.current
  const isAgent = displayActor?.actor_type === 'agent'

  if (!displayActor) return null

  return (
    <Dialog open={!!actor} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] w-[min(760px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden border-border bg-background p-0 shadow-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {isAgent
              ? t('actors.detail.agentTitle', 'Agent details')
              : t('actors.detail.memberTitle', 'Member details')}
          </DialogTitle>
          <DialogDescription>
            {t('actors.detail.description', 'View actor profile and presence.')}
          </DialogDescription>
        </DialogHeader>

        <ActorDetailContent
          actor={displayActor}
          teamId={teamId}
          onRemoved={onRemoved}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
