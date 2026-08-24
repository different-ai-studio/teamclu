import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useActorsForTeam, type ActorRow as ActorRowData } from '@/components/panel/ActorsView'
import { LocalDaemonRow } from '@/components/sidebar/LocalDaemonRow'
import { getLocalDaemonAgent } from '@/lib/daemon-agent-admin'
import { getKnownLocalDaemonActorId, noteLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { useLocalDaemonRuntimeStatus } from '@/hooks/use-local-daemon-http-status'
import { cn } from '@/lib/utils'
import { ActorDetailDialog } from '@/components/sidebar/ActorDetailDialog'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'

/**
 * The local daemon agent, pinned to the BOTTOM of the sidebar (just above the
 * Settings footer) inside a small bordered card. Giving it a home of its own
 * keeps its coral-emphasized styling from looking out of place among the other
 * nav rows.
 *
 * Self-contained: it resolves the local daemon actor itself and owns the
 * detail dialog and copy handlers.
 */
export function LocalDaemonCard() {
  const { t } = useTranslation()
  const { actors, refetch, teamId } = useActorsForTeam()
  const defaultAgentId = useMemberPreferencesStore((s) => s.defaultAgentId)

  const [detailFor, setDetailFor] = React.useState<ActorRowData | null>(null)

  const [localDaemonAgentId, setLocalDaemonAgentId] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!teamId) {
      setLocalDaemonAgentId(null)
      return
    }

    const knownId = getKnownLocalDaemonActorId()
    if (knownId && actors.some((a) => a.id === knownId)) {
      setLocalDaemonAgentId((prev) => prev ?? knownId)
    }

    let cancelled = false
    void getLocalDaemonAgent(teamId).then((a) => {
      if (cancelled || !a?.id) return
      setLocalDaemonAgentId(a.id)
      noteLocalDaemonActorId(a.id)
    })
    return () => { cancelled = true }
  }, [teamId, actors])

  const localDaemonActor = React.useMemo(
    () => actors.find((a) => a.id === localDaemonAgentId) ?? null,
    [actors, localDaemonAgentId],
  )
  const runtimeStatus = useLocalDaemonRuntimeStatus(
    localDaemonActor?.id ?? null,
    !!localDaemonActor,
  )
  const daemonMqttDisconnected = runtimeStatus === 'daemonMqttDisconnected'

  const handleCopyName = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async (actor: ActorRowData) => {
    try {
      await navigator.clipboard.writeText(actor.id)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  if (!localDaemonActor) return null

  return (
    <>
      <ActorDetailDialog
        actor={detailFor}
        teamId={teamId}
        onOpenChange={(open) => { if (!open) setDetailFor(null) }}
        onRemoved={refetch}
      />
      <div
        className={cn(
          'group/local-daemon flex max-h-[45vh] flex-col overflow-y-auto rounded-xl bg-paper p-2 shadow-[0_2px_8px_rgba(28,27,25,0.05),0_1px_2px_rgba(28,27,25,0.03)] ring-1 ring-black/[0.05] transition-[max-height,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none dark:ring-white/10',
          daemonMqttDisconnected && 'ring-1 ring-amber-400/45',
        )}
      >
        <LocalDaemonRow
          actor={localDaemonActor}
          runtimeStatus={runtimeStatus}
          isDefault={localDaemonActor.id === defaultAgentId}
          onViewDetail={setDetailFor}
          onCopyName={handleCopyName}
          onCopyId={handleCopyId}
        />
      </div>
    </>
  )
}
