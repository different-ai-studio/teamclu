import * as React from 'react'
import { useUIStore } from '@/stores/ui'

/**
 * Open state for a popover on the collapsed rail (更多, the local agent).
 * It opens on click, like any popover, and closes on an outside click or
 * Escape. It also closes once the user picks a destination anywhere: that is
 * the end of the errand.
 *
 * Pass `open` / `onOpenChange` to the Popover root and spread `contentProps`
 * on the panel.
 */
export function useRailPopover() {
  const [open, setOpen] = React.useState(false)
  const filter = useUIStore((s) => s.sidebarFilter)
  React.useEffect(() => {
    setOpen(false)
  }, [filter])

  return {
    open,
    onOpenChange: setOpen,
    contentProps: {
      // A rail panel is a menu of places, not a form: leave focus where it was.
      onOpenAutoFocus: (e: Event) => e.preventDefault(),
    },
  }
}
