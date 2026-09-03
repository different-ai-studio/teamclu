import { describe, it, expect, vi, beforeEach } from 'vitest'

const listVersions = vi.fn()
const fetchVersionContent = vi.fn()

vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: { getState: () => ({ listVersions }) },
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: { id: 'team-1' } }) },
}))
vi.mock('@/stores/version-history', () => ({
  useVersionHistoryStore: { getState: () => ({ fetchVersionContent }) },
}))

import { OssHistoryProvider } from '@/lib/history/oss-provider'

describe('OssHistoryProvider', () => {
  beforeEach(() => {
    listVersions.mockReset()
    fetchVersionContent.mockReset()
  })

  it('maps VersionInfo to HistoryEntry and resolves parentRef from loaded versions', async () => {
    listVersions.mockResolvedValue({
      versions: [
        { version: 3, parentVersion: 2, contentHash: 'h3', size: 1, deleted: false, createdBy: 'Alice', createdByNodeId: null, createdAt: '2026-05-03T00:00:00Z', message: 'edit' },
        { version: 2, parentVersion: 1, contentHash: 'h2', size: 1, deleted: false, createdBy: null, createdByNodeId: 'node-x', createdAt: '2026-05-02T00:00:00Z', message: null },
        { version: 1, parentVersion: 0, contentHash: 'h1', size: 1, deleted: false, createdBy: 'Bob', createdByNodeId: null, createdAt: '2026-05-01T00:00:00Z', message: 'init' },
      ],
      nextCursor: null,
    })

    const p = new OssHistoryProvider('/ws', 'knowledge/a.md')
    const page = await p.list(null)

    expect(listVersions).toHaveBeenCalledWith('/ws', 'knowledge/a.md', null)
    expect(page.entries[0]).toEqual({
      ref: 'h3',
      parentRef: 'h2',
      label: 'v3',
      author: 'Alice',
      timestamp: '2026-05-03T00:00:00Z',
      message: 'edit',
    })
    expect(page.entries[1].author).toBe('node-x')
    expect(page.entries[2].parentRef).toBe('')
    expect(page.nextCursor).toBeNull()
  })

  it('accumulates version->hash across pages so parentRef resolves at page boundary', async () => {
    listVersions
      .mockResolvedValueOnce({
        versions: [
          { version: 2, parentVersion: 1, contentHash: 'h2', size: 1, deleted: false, createdBy: null, createdByNodeId: null, createdAt: 't2', message: null },
        ],
        nextCursor: 'CURSOR1',
      })
      .mockResolvedValueOnce({
        versions: [
          { version: 1, parentVersion: 0, contentHash: 'h1', size: 1, deleted: false, createdBy: null, createdByNodeId: null, createdAt: 't1', message: null },
        ],
        nextCursor: null,
      })

    const p = new OssHistoryProvider('/ws', 'a.md')
    const first = await p.list(null)
    expect(first.entries[0].parentRef).toBe('')
    expect(first.nextCursor).toBe('CURSOR1')

    await p.list('CURSOR1')
    expect(listVersions).toHaveBeenLastCalledWith('/ws', 'a.md', 'CURSOR1')
  })

  it('reads content through the daemon call that resolves a blob', async () => {
    // The old route (`oss_sync_get_version_content`) had no implementation and
    // returned an error for every ref, so the editor's history preview failed
    // on exactly the files that have history.
    fetchVersionContent.mockResolvedValue('plain text')
    const p = new OssHistoryProvider('/ws', 'a.md')

    expect(await p.getContent('h9')).toBe('plain text')
    // Keyed by team + sync key, never by workspace — the same document has the
    // same history whichever surface opened it.
    expect(fetchVersionContent).toHaveBeenCalledWith('team-1', 'a.md', 'h9')
    expect(await p.getContent('')).toBe('')
  })
})
