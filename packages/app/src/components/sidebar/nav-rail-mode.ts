import * as React from 'react'

/**
 * How the first-column nav is being drawn.
 *
 * - `list` — the full-width list: pinned open on a wide window, or the drawer
 *   on a narrow one. Rows show labels and the 更多 fold.
 * - `rail-collapsed` — the fixed icon rail. Labels are hidden (they become the
 *   row's tooltip) and attention signals sit on the icon's corner.
 * - `rail-expanded` — the same rail, widened over column two while the pointer
 *   is on it.
 *
 * The two rail modes are one element changing width, not a rail plus a
 * separate flyout: every row keeps the same box in both, so the icon a user is
 * reaching for is still under the pointer when the labels slide in, and a click
 * lands on the row they aimed at whichever state it hits.
 */
export type NavRailMode = 'list' | 'rail-collapsed' | 'rail-expanded'

export const NavRailModeContext = React.createContext<NavRailMode>('list')

export function useNavRailMode(): NavRailMode {
  return React.useContext(NavRailModeContext)
}

export function isRailMode(mode: NavRailMode): boolean {
  return mode !== 'list'
}

/**
 * Row box for a nav entry. Rail rows get a fixed height and a wider inset so
 * the 15px icon sits on the 72px rail's centre line and the row is the same
 * size whether or not its label is showing.
 */
export function navRowBox(mode: NavRailMode): string {
  return isRailMode(mode) ? 'relative h-9 px-[18px]' : 'px-[9px] py-[7px]'
}

/** Label span: kept for screen readers when the rail hides it. */
export function navRowLabel(mode: NavRailMode): string {
  return mode === 'rail-collapsed'
    ? 'sr-only'
    : 'min-w-0 flex-1 truncate whitespace-nowrap'
}

/**
 * Where a row's attention signal goes. On the collapsed rail it moves onto the
 * icon's top-right corner, since there is no trailing slot to hold it.
 */
export function navRowSignal(mode: NavRailMode): string {
  return mode === 'rail-collapsed' ? 'absolute left-[29px] top-[5px]' : ''
}
