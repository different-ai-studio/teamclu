const APP_CODE_RE = /^a-[0-9a-hjkmnp-tv-z]{12}$/
const LEGACY_APP_CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/

/** Format current codes and legacy cached random parts without repairing invalid values. */
export function formatAppCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 14 && APP_CODE_RE.test(value)) return value
  if (value.length === 12 && LEGACY_APP_CODE_RE.test(value)) return `a-${value}`
  return null
}
