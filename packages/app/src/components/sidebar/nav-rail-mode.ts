import * as React from 'react'

/**
 * How the first-column nav is being drawn.
 *
 * - `list` — the full sidebar: pinned open on a wide window, or the drawer on
 *   a narrow one.
 * - `rail` — the fixed rail: each row is a square tile, the icon with its label
 *   in small type underneath, so the rail reads without hovering; attention
 *   signals sit on the icon's corner.
 *
 * The rail does not widen on hover. Its tiles are taller than list rows, so a
 * rail that turned into the list under the pointer put a different row under
 * it; with labels on the tiles there is nothing a hover would add.
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
