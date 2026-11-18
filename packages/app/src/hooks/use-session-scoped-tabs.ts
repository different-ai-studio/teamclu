import { useEffect } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { NO_SESSION_TAB_SCOPE, useTabsStore } from '@/stores/tabs'
import { useSectionMode } from '@/lib/layout/section-mode'

/**
 * Give each session — and each nav section that replaces the conversation —
 * its own set of column-four tabs.
 *
 * Opening another session parks the current tabs under the one being left and
 * brings back that session's own, so the files beside a chat are always that
 * chat's. A section (knowledge, skills, …) is a scope of its own: knowledge
 * documents do not pile up beside a conversation, and leaving the section
 * brings the session's tabs back untouched.
 */
export function useSessionScopedTabs(): void {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const section = useSectionMode()
  const key = section ? `section:${section}` : (activeSessionId ?? NO_SESSION_TAB_SCOPE)
  useEffect(() => {
    useTabsStore.getState().switchScope(key)
  }, [key])
}
