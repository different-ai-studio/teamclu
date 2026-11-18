import * as React from 'react'

/**
 * How the first-column nav is being drawn.
 *
 * - `list` — the full-width list: pinned open on a wide window, or the drawer
 *   on a narrow one. Rows show icon then label, and the 更多 fold.
 * - `rail-collapsed` — the fixed rail. Each row is a tile, a larger icon over
 *   a short label, so the rail reads without hovering; attention signals sit
 *   on the icon's corner.
 */
export type NavRailMode = 'list' | 'rail-collapsed'

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
 * users do not recognise an icon on its own. The list is the usual
 * icon-then-label row.
 */
export function navRowBox(mode: NavRailMode): string {
  return mode === 'rail-collapsed'
    ? 'relative flex-col justify-center gap-1 px-0.5 py-2 text-center'
    : 'px-[9px] py-[7px]'
}

/** Icon size: larger on the rail tile, where it carries the row. */
export function navRowIcon(mode: NavRailMode): string {
  return mode === 'rail-collapsed' ? 'h-5 w-5 shrink-0' : 'h-[15px] w-[15px] shrink-0'
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
