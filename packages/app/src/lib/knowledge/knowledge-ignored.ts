/**
 * Whether a sync key falls under one of the ignored roots.
 *
 * The daemon reports the shallowest path that explains each exclusion —
 * `knowledge/node_modules`, never the tens of thousands of files inside it (see
 * `scanner::scan_ignored`). So a descendant has to be recognised here, by
 * prefix.
 *
 * `syncKey` is the same key everything else in the knowledge tree is addressed
 * by: `knowledge/<path>`, from `teamSyncKeyForPath`.
 */
export function isIgnoredSyncKey(syncKey: string, ignoredRoots: Set<string>): boolean {
  if (ignoredRoots.size === 0) return false
  if (ignoredRoots.has(syncKey)) return true
  // Walk up the path rather than iterate the set: a knowledge tree is shallow,
  // and the ignored-root list can hold one entry per dependency directory in a
  // repo somebody dropped in.
  let slash = syncKey.lastIndexOf('/')
  while (slash > 0) {
    if (ignoredRoots.has(syncKey.slice(0, slash))) return true
    slash = syncKey.lastIndexOf('/', slash - 1)
  }
  return false
}
