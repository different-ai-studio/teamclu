import * as React from 'react'

/**
 * How the first-column nav is being drawn.
 *
 * - `list` — the full sidebar: pinned open on a wide window, the drawer on a
 *   narrow one, and the rail while it is widened under the pointer. Widening
 *   does not have a look of its own; it is the pinned sidebar, floated over
 *   column two.
 * - `rail` — the fixed rail: each row is only its icon (the label becomes the
 *   tooltip), and attention signals sit on the icon's corner.
 *
 * Rail rows are as tall as list rows, so an icon is on the same line as its
 * row when the rail widens.
 */
export type NavRailMode = 'list' | 'rail'

export const NavRailModeContext = React.createContext<NavRailMode>('list')

export function useNavRailMode(): NavRailMode {
  return React.useContext(NavRailModeContext)
}

export function isRailMode(mode: NavRailMode): boolean {
  return mode === 'rail'
}

/**
 * Row box for a nav entry. On the rail the icon is centred and the label
 * shrinks to nothing but stays in the line, so the row keeps the list row's
 * height and rows line up across the two.
 */
export function navRowBox(mode: NavRailMode): string {
  return mode === 'rail' ? 'relative justify-center gap-0 px-0 py-[7px]' : 'px-[9px] py-[7px]'
}

/** Icon size: the list's in both, so the rail is the list with labels hidden. */
export function navRowIcon(_mode: NavRailMode): string {
  return 'h-[15px] w-[15px] shrink-0'
}

/** Label span: zero-width on the rail, still read by screen readers and
 * still holding the row's line height. */
export function navRowLabel(mode: NavRailMode): string {
  return mode === 'rail' ? 'w-0 overflow-hidden whitespace-nowrap' : 'min-w-0 flex-1 truncate whitespace-nowrap'
}

/**
 * Where a row's attention signal goes. On the rail it moves onto the icon's
 * top-right corner, since there is no trailing slot to hold it.
 */
export function navRowSignal(mode: NavRailMode): string {
  return mode === 'rail' ? 'absolute left-1/2 top-0' : ''
}
