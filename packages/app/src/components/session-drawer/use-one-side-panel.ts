import { useEffect, useRef } from 'react'
import { useThreadPanelStore } from '@/stores/thread-panel-store'
import { useThreadListPanelStore } from '@/stores/thread-list-panel-store'

/**
 * A session shows one side panel at a time: the drawer (files / actors / app
 * settings) or a thread panel (thread list / a thread). Whichever opened last
 * wins and the other closes, so column three never stacks two panels beside
 * the conversation.
 */
export function useOneSessionSidePanel(drawerOpen: boolean, closeDrawer: () => void): void {
  const threadOpen = useThreadPanelStore((s) => s.isOpen)
  const threadListOpen = useThreadListPanelStore((s) => s.isOpen)
  const threadShown = threadOpen || threadListOpen
  const prev = useRef({ drawerOpen, threadShown })

  useEffect(() => {
    const before = prev.current
    prev.current = { drawerOpen, threadShown }
    if (drawerOpen && !before.drawerOpen && threadShown) {
      useThreadPanelStore.getState().close()
      useThreadListPanelStore.getState().close()
    } else if (threadShown && !before.threadShown && drawerOpen) {
      closeDrawer()
    }
  }, [drawerOpen, threadShown, closeDrawer])
}
