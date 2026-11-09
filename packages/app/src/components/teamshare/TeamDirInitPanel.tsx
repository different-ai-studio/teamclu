import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderPlus, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { linkDaemonTeamWorkspace, TEAM_LINK_LEGACY_DAEMON } from '@/lib/daemon/daemon-local-client'
import { isTauri } from '@/lib/utils'

type Props = {
  /** Called after the team folder is back so the parent can refresh the tree. */
  onRebuilt?: () => void
}

/**
 * Repair for a team whose sync root is missing on this machine:
 * `POST /v1/team/link` rebuilds it and pulls the team content down.
 *
 * It does not lay down any folder structure. Knowledge content is grown as a
 * Wiki from the documents library, not from a fixed scaffold.
 */
export function TeamDirInitPanel({ onRebuilt }: Props) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const ready = isTauri()

  async function handleRebuild() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await linkDaemonTeamWorkspace(workspacePath, { strict: true })
      await loadSection('knowledge', { force: true })
      if (!useTeamShareBrowserStore.getState().syncRoot) {
        setError(
          t(
            'teamShare.dirMissingStillMissing',
            'Rebuilt, but the team folder is still not here. The local daemon is probably out of date — restart or update it, then try again.',
          ),
        )
        return
      }
      onRebuilt?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(
        msg === TEAM_LINK_LEGACY_DAEMON
          ? t(
              'teamShare.dirMissingDaemonTooOld',
              'The local daemon is too old to create the team folder on its own. Restart or update it, then try again.',
            )
          : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" data-testid="knowledge-init-panel">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <FolderPlus className="h-5 w-5" />
      </span>
      <p className="text-[13px] font-medium text-foreground">
        {t('teamShare.dirMissingTitle', 'Team folder is missing on this machine')}
      </p>
      <p className="max-w-[280px] text-[12.5px] leading-relaxed text-muted-foreground">
        {t(
          'teamShare.dirMissingBody',
          "Team sync is on, but the team's folder is not on this machine yet. Rebuilding creates it and pulls the team content down.",
        )}
      </p>

      {ready ? (
        <Button
          size="sm"
          onClick={() => void handleRebuild()}
          disabled={busy}
          data-testid="knowledge-init-action"
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t('teamShare.dirMissingAction', 'Rebuild team folder')}
        </Button>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {t('teamShare.dirMissingNeedsDesktop', 'This can only be repaired from the desktop app.')}
        </p>
      )}

      {error && <p className="max-w-[280px] text-[12px] text-red-500">{error}</p>}
    </div>
  )
}
