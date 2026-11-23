import { useEffect } from 'react'
import { CHAT_TAB_SCOPE, useTabsStore } from '@/stores/tabs'
import { useSectionMode } from '@/lib/layout/section-mode'

/**
 * Give each nav section that replaces the conversation (knowledge, skills, …)
 * its own set of column-four tabs, and the conversation one shared set.
 *
 * The conversation's tabs are not tied to a session: opening another session,
 * starting a new chat or sending a draft's first message leaves column four as
 * it is. A page opened from 快捷方式 or a file from the tree belongs to the
 * user's work, not to whichever chat happened to be open. Sections do get
 * their own scope, so knowledge documents do not pile up beside the chat, and
 * leaving a section brings the conversation's tabs back untouched.
 */
export function useSectionScopedTabs(): void {
  const section = useSectionMode()
  const key = section ? `section:${section}` : CHAT_TAB_SCOPE
  useEffect(() => {
    useTabsStore.getState().switchScope(key)
  }, [key])
}
