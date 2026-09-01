import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderPlus, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { linkDaemonTeamWorkspace, TEAM_LINK_LEGACY_DAEMON } from '@/lib/daemon-local-client'
import { isTauri } from '@/lib/utils'

/**
 * Shown in the Knowledge column when the team's knowledge directory is missing
 * on THIS machine — `~/.amuxd[-<brand>]/teams/<id>/shared/knowledge` is not
 * there, so there is no root to render a file tree from. (It no longer means
 * "this workspace has no symlink": the column reads that directory by absolute
 * path and does not go through the workspace link at all.)
 *
 * This is a local-state problem, not an account one: sync is on for the team
 * either way. The daemon owns the directory, and `POST /v1/team/link` is
 * idempotent — it materializes whichever half is missing. So the fix is one
 * button, and pressing it twice is harmless.
 *
 * `strict: true` because the whole point here is to report failure: the
 * best-effort default would swallow "daemon not running", which is the most
 * likely reason the directory is missing in the first place.
 */
export function TeamDirInitPanel() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // A workspace is not required: the repair this button performs is "create the
  // team's directory", which belongs to the team. When a folder IS open its
  // team links get repaired too, as a bonus.
  const ready = isTauri()

  async function handleInit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await linkDaemonTeamWorkspace(workspacePath, { strict: true })
      // Re-resolving the root is enough. It reads the daemon's directory
      // directly, so there is no cached workspace tree standing between the
      // repair and the column noticing it.
      await loadSection('knowledge', { force: true })

      // "The call succeeded" is not "the repair worked". A daemon older than
      // the knowledge relocation materializes the previous layout
      // (`shared/teamclu-team/knowledge`) and answers 200 — nothing this column
      // reads has changed, no exception was thrown, and the panel re-renders
      // itself unchanged. That is indistinguishable from a dead button, and it
      // is what a user actually hit: four clicks, four 200s, no feedback.
      //
      // So check the outcome, not the call.
      if (!useTeamShareBrowserStore.getState().syncRoot) {
        setError(
          t(
            'teamShare.dirMissingStillMissing',
            'Rebuilt, but the team folder is still not here. The local daemon is probably out of date — restart or update it, then try again.',
          ),
        )
      }
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
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
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
        <Button size="sm" onClick={() => void handleInit()} disabled={busy}>
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
