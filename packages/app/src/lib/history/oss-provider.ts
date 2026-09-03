import { useOssSyncStore } from '@/stores/oss-sync'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useVersionHistoryStore } from '@/stores/version-history'
import type { HistoryProvider, HistoryPage } from '@/lib/history/types'

/**
 * History backed by FC server-side version records (OSS sync mode).
 * Maintains a version->contentHash map across pages so each entry's
 * parentRef (its parentVersion's hash) can be resolved client-side.
 */
export class OssHistoryProvider implements HistoryProvider {
  private readonly versionToHash = new Map<number, string>()

  constructor(
    /** Optional; the daemon keys versions by team + sync key, not by workspace. */
    private readonly workspacePath: string | null,
    private readonly path: string,
  ) {}

  async list(cursor: string | null): Promise<HistoryPage> {
    const { versions, nextCursor } = await useOssSyncStore
      .getState()
      .listVersions(this.workspacePath, this.path, cursor)

    // First pass: record every version's hash so parent lookups within this
    // page succeed regardless of array order.
    for (const v of versions) {
      if (v.contentHash) this.versionToHash.set(v.version, v.contentHash)
    }

    const entries = versions.map((v) => ({
      ref: v.contentHash ?? '',
      parentRef: this.versionToHash.get(v.parentVersion) ?? '',
      label: `v${v.version}`,
      author: v.createdBy ?? v.createdByNodeId,
      timestamp: v.createdAt,
      message: v.message,
    }))

    return { entries, nextCursor: nextCursor ?? null }
  }

  /**
   * The content of one historical version.
   *
   * Goes through `team_file_content` — the daemon call that actually resolves a
   * blob — rather than the `oss_sync_get_version_content` proxy this used to
   * call, which never had an implementation and returned an error for every
   * ref. That made the editor's history preview permanently broken for exactly
   * the files that have history: team knowledge documents.
   */
  async getContent(ref: string): Promise<string | null> {
    if (ref === '') return ''
    const teamId = useCurrentTeamStore.getState().team?.id
    if (!teamId) return null
    return useVersionHistoryStore.getState().fetchVersionContent(teamId, this.path, ref)
  }
}
