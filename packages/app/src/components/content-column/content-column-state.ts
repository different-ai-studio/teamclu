import { useTabsStore } from '@/stores/tabs'
import { useUIStore, type ContentColumnMode } from '@/stores/ui'
import { useLayoutBreakpoint } from '@/hooks/use-layout-breakpoint'

/**
 * The mode column four actually renders in. Below the wide breakpoint there is
 * no room to share the row, so it always takes the whole content area.
 */
export function useEffectiveContentColumnMode(): ContentColumnMode {
  const mode = useUIStore((s) => s.contentColumnMode)
  const breakpoint = useLayoutBreakpoint()
  return breakpoint === 'wide' ? mode : 'full'
}

/** True while column four is on screen: exactly when a tab is active. */
export function useContentColumnVisible(): boolean {
  return useTabsStore((s) => s.activeTabId !== null)
}
