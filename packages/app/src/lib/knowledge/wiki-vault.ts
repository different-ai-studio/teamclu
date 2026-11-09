/**
 * LLM Wiki lives at `knowledge/wiki/` in the synced vault.
 *
 * Agent-owned: humans do not create, rename, or edit inside it. Corrections go
 * to the source in `documents/` or to `_schema.md`.
 *
 * The editor sometimes keys paths from the knowledge root itself (`wiki/…`)
 * rather than the team-sync root (`knowledge/wiki/…`). Both spellings are Wiki.
 */
export function isLlmWikiSyncKey(syncKey: string | null | undefined): boolean {
  if (!syncKey) return false
  if (syncKey.startsWith('documents/')) return false
  return (
    syncKey === 'knowledge/wiki' ||
    syncKey.startsWith('knowledge/wiki/') ||
    syncKey === 'wiki' ||
    syncKey.startsWith('wiki/')
  )
}

/**
 * Whether the team has a published Wiki on this machine. The maintainer always
 * publishes `wiki/index.md`, so its absence means nothing has been published.
 */
export async function isWikiPublished(syncRoot: string): Promise<boolean> {
  const { exists } = await import('@tauri-apps/plugin-fs')
  return exists(`${syncRoot}/knowledge/wiki/index.md`)
}
