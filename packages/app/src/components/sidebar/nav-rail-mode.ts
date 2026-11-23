import * as React from 'react'

/**
 * How the first-column nav is being drawn.
 *
 * - `list` — the full sidebar: pinned open on a wide window, the drawer on a
 *   narrow one, and the rail while it is widened under the pointer. Widening
 *   does not have a look of its own; it is the pinned sidebar, floated over
 *   column two.
 * - `rail` — the fixed rail: each row is a square tile, the icon with its label
 *   in small type underneath, so the rail reads without hovering; attention
 *   signals sit on the icon's corner.
 */
export type NavRailMode = 'list' | 'rail'

export const NavRailModeContext = React.createContext<NavRailMode>('list')

export function useNavRailMode(): NavRailMode {
  return React.useContext(NavRailModeContext)
}

export function isRailMode(mode: NavRailMode): boolean {
  return mode === 'rail'
}

/** Row box for a nav entry: a tile on the rail, the compact row in the list. */
export function navRowBox(mode: NavRailMode): string {
  return mode === 'rail'
    ? 'relative h-14 flex-col justify-center gap-1 px-0.5 text-center'
    : 'px-[9px] py-[7px]'
}

/** Icon size: larger on the tile, where it carries the row. */
export function navRowIcon(mode: NavRailMode): string {
  return mode === 'rail' ? 'h-5 w-5 shrink-0' : 'h-[15px] w-[15px] shrink-0'
}

/** Label span: under the icon on the tile, beside it in the list. */
export function navRowLabel(mode: NavRailMode): string {
  return mode === 'rail'
    ? 'w-full truncate whitespace-nowrap text-[12px] leading-[15px]'
    : 'min-w-0 flex-1 truncate whitespace-nowrap'
}

/**
 * Where a row's attention signal goes. On the rail it moves onto the icon's
 * top-right corner, since there is no trailing slot to hold it.
 */
export function navRowSignal(mode: NavRailMode): string {
  return mode === 'rail' ? 'absolute left-1/2 top-1 ml-1.5' : ''
}
