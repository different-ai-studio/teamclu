/**
 * Comparing filesystem paths that reach the frontend spelled differently.
 *
 * The same directory arrives here in two spellings on Windows. Paths the
 * frontend builds itself join with `/` onto whatever `homeDir()` returned
 * (`C:\Users\x` + `/.amuxd/teams/<id>/shared/team-sync`), while every path that
 * comes back from Rust is a `PathBuf` rendered with the platform separator
 * (`C:\Users\x\.amuxd\teams\<id>\shared\team-sync\documents`). Windows treats
 * both as the same path; `startsWith(`${root}/`)` does not, and that mismatch
 * is what emptied the whole team knowledge tree on Windows — the two roots
 * listed, and every child below them was attributed to no tree at all.
 *
 * Case is deliberately NOT folded. Windows and macOS are case-insensitive by
 * default, but a case-folded compare would also make `/srv/Docs` and
 * `/srv/docs` the same directory on Linux, where they are not. Both sides of
 * these comparisons come from the same source spelled two ways, so separators
 * are the whole of the problem.
 */

/** `\` → `/`, with trailing separators dropped, for comparison only. */
export function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Whether `path` is `root` itself, or sits under it.
 *
 * The match is on a path boundary, so `/a/bc` is not under `/a/b`.
 */
export function isPathAtOrUnder(path: string, root: string): boolean {
  const p = normalizePathForCompare(path)
  const r = normalizePathForCompare(root)
  return p === r || p.startsWith(`${r}/`)
}

/** Whether `path` sits strictly under `root` — the root itself does not count. */
export function isPathUnder(path: string, root: string): boolean {
  const p = normalizePathForCompare(path)
  const r = normalizePathForCompare(root)
  return p.startsWith(`${r}/`)
}

/**
 * The part of `path` below `root`, always `/`-separated, or null when `path` is
 * not under `root`.
 *
 * Empty string is never returned: `path === root` has no relative part, and a
 * caller asking for one wants to know that it is the root, not to be handed a
 * key that reads as a file with no name.
 */
export function relativePathUnder(path: string, root: string): string | null {
  const p = normalizePathForCompare(path)
  const r = normalizePathForCompare(root)
  if (!p.startsWith(`${r}/`)) return null
  const rest = p.slice(r.length + 1)
  return rest.length > 0 ? rest : null
}

/** Whether two paths name the same file or directory. */
export function isSamePath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b)
}

/**
 * Append `child` to `parent` using the separator `parent` is already written
 * with.
 *
 * A path built for the UI has to come out spelled the way Rust spells it: these
 * strings are compared literally against listed nodes and against
 * `expandedPaths`, and a `/` joined onto a Windows path produces something that
 * opens fine but matches nothing.
 */
/**
 * The last segment of a path, whichever separator it is written with.
 *
 * `lastIndexOf('/')` returns -1 for a Windows path, which hands back the whole
 * `C:\…\report.pdf` as the "file name".
 */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

export function joinPathLike(parent: string, child: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[/\\]+$/, '')}${separator}${child.replace(/^[/\\]+/, '')}`
}
