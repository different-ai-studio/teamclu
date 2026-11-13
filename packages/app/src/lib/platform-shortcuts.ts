import { isMacPlatform } from '@/lib/platform'

/**
 * Render a shortcut hint for UI labels (not for registering accelerators).
 * `mod` is ⌘ on macOS and Ctrl elsewhere.
 */
export function formatShortcut(spec: string): string {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)

  const modGlyph = isMacPlatform() ? '⌘' : 'Ctrl+'
  let out = ''

  for (const part of parts) {
    if (part === 'mod') {
      out += modGlyph
      continue
    }
    if (part === 'ctrl' || part === 'control') {
      out += isMacPlatform() ? '⌃' : 'Ctrl+'
      continue
    }
    if (part === 'shift') {
      out += '⇧'
      continue
    }
    if (part === 'alt' || part === 'option') {
      out += isMacPlatform() ? '⌥' : 'Alt+'
      continue
    }
    if (part === 'enter' || part === 'return') {
      out += '↵'
      continue
    }
    if (part === '`' || part === 'backquote') {
      out += '`'
      continue
    }
    out += part.length === 1 ? part.toUpperCase() : part
  }

  return out
}
