import { useEffect } from 'react'
import {
  EXTENSION_SESSION_CLEANUP_INTERVAL_MS,
  runExtensionSessionCleanup,
} from '@/lib/extension-session-cleanup'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useUIStore } from '@/stores/ui'

const INITIAL_DELAY_MS = 30_000

/**
 * Extension / plugin embed only: periodically archive stale sessions
 * (7+ days idle, or 3+ days idle when empty).
 */
export function useExtensionSessionCleanup() {
  const embedMode = useUIStore((s) => s.embedMode)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const userId = useAuthStore((s) => s.session?.user?.id ?? null)

  useEffect(() => {
    if (!embedMode || !teamId || !userId) return

    let cancelled = false

    const sweep = async () => {
      if (cancelled) return
      try {
        await runExtensionSessionCleanup({
          userId,
          teamId,
          shouldAbort: () => cancelled,
        })
      } catch (error) {
        console.warn('[extension-session-cleanup] sweep failed', error)
      }
    }

    const initialTimer = window.setTimeout(() => void sweep(), INITIAL_DELAY_MS)
    const interval = window.setInterval(() => void sweep(), EXTENSION_SESSION_CLEANUP_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [embedMode, teamId, userId])
}
