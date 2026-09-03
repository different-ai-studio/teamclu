import * as React from 'react'

/**
 * Latches to `true` the first time `value` is true and stays there.
 *
 * Built for dialogs that live in the tree permanently with `open={false}`:
 * wrapping one in `React.lazy` alone defers nothing, because the lazy module
 * loads the moment the closed dialog mounts. Gating the mount on this latch
 * defers the load to the first open, and keeping it mounted afterwards
 * preserves the close animation and any state the dialog holds between opens.
 */
export function useEverTrue(value: boolean): boolean {
  const [seen, setSeen] = React.useState(value)
  if (value && !seen) setSeen(true)
  return seen || value
}
