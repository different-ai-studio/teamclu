import { useOssSyncStore } from '@/stores/oss-sync'
import type { HistoryProvider, HistoryPage } from './types'

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

  getContent(ref: string): Promise<string | null> {
    if (ref === '') return Promise.resolve('')
    return useOssSyncStore.getState().getVersionContent(this.workspacePath, ref)
  }
}
