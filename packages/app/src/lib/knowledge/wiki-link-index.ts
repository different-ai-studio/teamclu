/** Map of lowercased filename (no ext) → relative path */
export type WikiFileMap = Map<string, string>

interface PageNameEntry {
  name: string   // display name (original case, no extension)
  dir: string    // relative directory under knowledge/ (e.g. "project/"), empty for root
}

/** Extract basename (last path segment) without the given extension */
function basename(path: string, ext: string): string {
  const lastSlash = path.lastIndexOf('/')
  const name = lastSlash === -1 ? path : path.slice(lastSlash + 1)
  return name.endsWith(ext) ? name.slice(0, -ext.length) : name
}

/** Get the directory portion of a path (empty string for root-level) */
function dirname(path: string): string {
  const lastSlash = path.lastIndexOf('/')
  return lastSlash === -1 ? '' : path.slice(0, lastSlash)
}

/**
 * Build a file map from an array of relative file paths (relative to workspace root).
 * Only includes .md files. On name collision, keeps shortest path (shallowest nesting).
 */
export function buildFileMap(paths: string[]): WikiFileMap {
  const map: WikiFileMap = new Map()

  for (const p of paths) {
    if (!p.endsWith('.md')) continue

    const fileName = basename(p, '.md')
    const key = fileName.toLowerCase()
    const existing = map.get(key)

    // Keep shortest path (shallowest nesting)
    if (!existing || p.split('/').length < existing.split('/').length) {
      map.set(key, p)
    }
  }

  return map
}

/**
 * Resolve a wiki link target to a relative file path.
 * Case-insensitive lookup by filename.
 */
export function resolveWikiLink(map: WikiFileMap, target: string): string | null {
  return map.get(target.toLowerCase()) ?? null
}

/**
 * Get all page name entries for autocomplete display.
 * Returns name (original case, no extension) and parent directory (relative to knowledge/).
 */
export function getAllPageNames(map: WikiFileMap): PageNameEntry[] {
  const entries: PageNameEntry[] = []
  for (const filePath of map.values()) {
    const name = basename(filePath, '.md')
    const dir = dirname(filePath)
    // Strip leading "knowledge/" or "knowledge" prefix for display
    let displayDir = dir
    if (displayDir === 'knowledge') {
      displayDir = ''
    } else if (displayDir.startsWith('knowledge/')) {
      displayDir = displayDir.slice('knowledge/'.length)
    }
    entries.push({ name, dir: displayDir ? `${displayDir}/` : '' })
  }
  return entries
}
