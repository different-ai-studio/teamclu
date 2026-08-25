import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareStore } from '@/stores/team-share'
import { useOssSyncStore } from '@/stores/oss-sync'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import { isTauri } from '@/lib/utils'

/**
 * Manual "sync with the cloud" action for toolbar buttons.
 *
 * `available` is false while the team has no locked share mode, so callers can
 * hide the button entirely.
 *
 * On success a TEAM_SYNCED_EVENT is dispatched; consumers that need to reload
 * after a sync should listen for that event rather than wrap `syncNow`, so they
 * also pick up syncs triggered from other surfaces.
 */
export function useTeamCloudSync() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const shareMode = useTeamShareStore((s) => s.status.mode)
  const syncing = useOssSyncStore((s) => s.syncing)
  const ossSyncNow = useOssSyncStore((s) => s.syncNow)

  // No workspace requirement: the daemon syncs the team's own tree under its
  // amuxd home, so "no folder open" is not a reason to hide the button. A
  // workspace, when there is one, is passed along only so the daemon can repair
  // its team links on the way through.
  const available = isTauri() && shareMode === 'oss'

  const syncNow = React.useCallback(async () => {
    if (!available || syncing) return
    await ossSyncNow(workspacePath)
    const err = useOssSyncStore.getState().lastError
    if (err) {
      toast.error(t('teamShare.cloudSyncFailed', 'Sync failed: {{msg}}', { msg: err }))
      return
    }
    window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
  }, [available, syncing, workspacePath, ossSyncNow, t])

  return { available, syncing, syncNow }
}
