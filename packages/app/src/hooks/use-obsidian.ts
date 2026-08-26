import * as React from 'react'

import {
  getObsidianStatus,
  OBSIDIAN_ABSENT,
  type ObsidianStatus,
} from '@/lib/obsidian'

/**
 * Obsidian's availability for `vaultPath`, refreshed when the window regains
 * focus.
 *
 * The focus listener is the point: installing Obsidian, or adding the folder as
 * a vault, both happen in another app. Without it the button stays grey (or
 * keeps claiming the vault is unregistered) until the app restarts, which is
 * exactly the moment the user just did the thing we asked them to do.
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
