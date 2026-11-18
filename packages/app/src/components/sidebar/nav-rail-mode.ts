import * as React from 'react'

/**
 * How the first-column nav is being drawn.
 *
 * - `list` — the full-width list: pinned open on a wide window, or the drawer
 *   on a narrow one. Rows show icon then label, and the 更多 fold.
 * - `rail-collapsed` — the fixed rail. Each row is a tile, a larger icon over
 *   a short label, so the rail reads without hovering; attention signals sit
 *   on the icon's corner.
 * - `rail-expanded` — the same rail, widened over column two while the pointer
 *   is on it: icon then label, plus the trailing controls.
 *
 * The two rail modes are one element changing width, not a rail plus a
 * separate flyout. Rows are the same height in both and the icon keeps its
 * horizontal place, so the row a user is reaching for is still under the
 * pointer when it widens, and a click lands on the row they aimed at whichever
 * state it hits.
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
 * Row box for a nav entry.
 *
 * On the collapsed rail a row is a tile: a 20px icon with its label in small
 * type underneath, so the rail is readable without hovering — many of our
 * users do not recognise an icon on its own. Widened, the row keeps the tile's
 * height and puts the icon on the same vertical line (6px rail inset + 24px +
 * half the 20px icon = the 80px rail's centre), with the label beside it.
 * The list is the usual compact icon-then-label row.
 */
export function navRowBox(mode: NavRailMode): string {
  if (mode === 'rail-collapsed') return 'relative h-14 flex-col justify-center gap-1 px-0.5 text-center'
  if (mode === 'rail-expanded') return 'relative h-14 gap-3 pl-6 pr-3'
  return 'px-[9px] py-[7px]'
}

/** Icon size: larger on the rail, where it carries the row, in both widths. */
export function navRowIcon(mode: NavRailMode): string {
  return isRailMode(mode) ? 'h-5 w-5 shrink-0' : 'h-[15px] w-[15px] shrink-0'
}

/** Label span: under the icon on the tile, beside it everywhere else. */
export function navRowLabel(mode: NavRailMode): string {
  return mode === 'rail-collapsed'
    ? 'w-full truncate whitespace-nowrap text-[12px] leading-[15px]'
    : 'min-w-0 flex-1 truncate whitespace-nowrap'
}

/**
 * Where a row's attention signal goes. On the tile it moves onto the icon's
 * top-right corner, since there is no trailing slot to hold it.
 */
export function navRowSignal(mode: NavRailMode): string {
  return mode === 'rail-collapsed' ? 'absolute right-3 top-1' : ''
}
