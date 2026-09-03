import * as React from 'react'

import {
  getObsidianStatus,
  OBSIDIAN_ABSENT,
  type ObsidianStatus,
} from '@/lib/knowledge/obsidian'

/**
 * Obsidian's availability for `vaultPath`, refreshed when the window regains
 * focus.
 *
 * The focus listener is the point: installing Obsidian, and restarting it after
 * a first-run registration, both happen in another app. Without it the button
 * stays grey — or keeps claiming a restart is needed — until this app restarts,
 * which is exactly the moment the user just did what we asked.
 */
export function useObsidianStatus(vaultPath: string | null): ObsidianStatus {
  const [status, setStatus] = React.useState<ObsidianStatus>(OBSIDIAN_ABSENT)

  React.useEffect(() => {
    // No path means the caller has nothing to open — a column that is not
    // Knowledge, or a machine with no team dir. Skip the probe rather than
    // spend an IPC round-trip per focus on an answer nobody renders.
    if (!vaultPath) {
      setStatus(OBSIDIAN_ABSENT)
      return
    }
    let cancelled = false
    const probe = async () => {
      const next = await getObsidianStatus(vaultPath)
      if (!cancelled) setStatus(next)
    }
    void probe()
    window.addEventListener('focus', probe)
    return () => {
      cancelled = true
      window.removeEventListener('focus', probe)
    }
  }, [vaultPath])

  return status
}
