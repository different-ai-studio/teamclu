/**
 * The right-hand slot of a first-column nav row — the session count badge, the
 * contacts "+", a team-share section count.
 *
 * They share one box on purpose: each row right-aligns its own trailing element,
 * so unless the boxes are identical the glyphs inside them land on different
 * vertical lines (a 2px-inset icon next to a 5px-inset pill reads as crooked
 * even though the boxes are flush).
 */
export const NAV_ROW_TRAILING_SLOT =
  'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-[5px]'
