/**
 * Deterministic palette assignment for actor letter-avatars.
 *
 * The prototype hand-picked one color per actor (coral, violet, green, amber,
 * blue, slate, ink). Real data doesn't carry an avatarColor field, so we
 * derive a stable color from the actor id (or display name as fallback). Same
 * actor → same color across the app.
 *
 * Returns CSS `background` + `color` so callers can apply directly.
 *
 * The palette is intentionally muted-but-saturated (~55% saturation, ~50%
 * lightness) so a 20px disc with a single letter pops without screaming —
 * matches AGENTS.md §1 "Direction B paper palette".
 */

const PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#e85a4a', fg: '#fff' }, // coral (brand)
  { bg: '#7a6cf5', fg: '#fff' }, // violet
  { bg: '#3a8f63', fg: '#fff' }, // green
  { bg: '#c98a3c', fg: '#fff' }, // amber
  { bg: '#3a6dbf', fg: '#fff' }, // blue
  { bg: '#a5527c', fg: '#fff' }, // plum
  { bg: '#1f8b94', fg: '#fff' }, // teal
  { bg: '#6a7a3a', fg: '#fff' }, // olive
  { bg: '#b56042', fg: '#fff' }, // terracotta
  { bg: '#5a6a7a', fg: '#fff' }, // slate
]

function hashString(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** Pick a stable palette slot for a given actor key (id preferred, name fallback). */
export function actorAvatarColor(key: string | null | undefined): { bg: string; fg: string } {
  if (!key) return PALETTE[PALETTE.length - 1]
  return PALETTE[hashString(key) % PALETTE.length]
}
