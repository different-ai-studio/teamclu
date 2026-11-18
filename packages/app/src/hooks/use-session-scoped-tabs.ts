import { useEffect } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { NO_SESSION_TAB_SCOPE, useTabsStore } from '@/stores/tabs'

/**
 * Give each session its own set of column-four tabs.
 *
 * Opening another session parks the current tabs under the one being left and
 * brings back that session's own — so the files beside a chat are always that
 * chat's, and a session with nothing open shows no column four at all.
 */
export function useSessionScopedTabs(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  useEffect(() => {
    useTabsStore.getState().switchScope(activeSessionId ?? NO_SESSION_TAB_SCOPE)
  }, [activeSessionId])
}
