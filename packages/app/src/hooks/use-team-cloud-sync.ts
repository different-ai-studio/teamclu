import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useWorkspaceStore } from '@/stores/workspace'
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
  const syncing = useOssSyncStore((s) => s.syncing)
  const ossSyncNow = useOssSyncStore((s) => s.syncNow)

  // Neither a workspace nor a share-mode flag. The daemon syncs the team's own
  // tree under its amuxd home, and whether that tree can sync is decided by the
  // team secret, where the sync runs — not by a cloud switch nothing sets.
  //
  // Gating on `shareMode === 'oss'` is what made this button do nothing at all:
  // `syncNow` returned before doing any work, with no toast and no error, on
  // every team whose flag was never set (which is every team created since the
  // enable call was removed from the product).
  const available = isTauri()

  const syncNow = React.useCallback(async () => {
    if (!available || syncing) return
    await ossSyncNow(workspacePath)
    const { lastError: err, failed } = useOssSyncStore.getState()
    if (err) {
      toast.error(t('teamShare.cloudSyncFailed', 'Sync failed: {{msg}}', { msg: err }))
      return
    }
    // A tick can return Ok while leaving files behind — a blob this device
    // cannot decode, a download that 404s. Those are retried every tick, but
    // reporting the run as a plain success is how the condition stayed
    // invisible for as long as it did.
    if (failed > 0) {
      toast.warning(
        t('teamShare.cloudSyncStuckFiles', '{{count}} files still cannot sync — retrying each time', {
          count: failed,
        }),
      )
    }
    window.dispatchEvent(new CustomEvent(TEAM_SYNCED_EVENT))
  }, [available, syncing, workspacePath, ossSyncNow, t])

  return { available, syncing, syncNow }
}
