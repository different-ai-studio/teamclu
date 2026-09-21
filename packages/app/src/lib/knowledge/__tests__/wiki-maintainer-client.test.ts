import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invoke,
  listKnownDocuments,
  fetchDocuments,
  listKnowledgeAcl,
  refreshExternalRoot,
} = vi.hoisted(() => ({
  invoke: vi.fn(),
  listKnownDocuments: vi.fn(),
  fetchDocuments: vi.fn(),
  listKnowledgeAcl: vi.fn(),
  refreshExternalRoot: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  listKnownDocuments,
  fetchDocuments,
}))
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({ knowledgeAcl: { listKnowledgeAcl } }),
}))
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: {
    getState: () => ({ syncRoot: '/team/shared/team-sync' }),
  },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ refreshExternalRoot }),
  },
}))

import {
  prepareWikiMaintenance,
  publishWikiMaintenance,
} from '../wiki-maintainer-client'

describe('wiki-maintainer-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('materializes only missing documents under selected folders before prepare', async () => {
    listKnowledgeAcl.mockResolvedValue([{ pathPrefix: 'documents/restricted/' }])
    listKnownDocuments.mockResolvedValue([
      { path: 'documents/handbook/a.pdf', version: 1, size: 10 },
      { path: 'documents/training/b.pdf', version: 1, size: 20 },
    ])
    fetchDocuments.mockResolvedValue(1)
    invoke.mockResolvedValue({ runId: 'run-1' })

    await prepareWikiMaintenance('team-1', ['documents/handbook/'])

    expect(fetchDocuments).toHaveBeenCalledWith('team-1', [
      'documents/handbook/a.pdf',
    ])
    expect(invoke).toHaveBeenCalledWith('kb_maintainer_prepare', {
      request: expect.objectContaining({
        aclPrefixes: ['documents/restricted/'],
      }),
    })
  })

  it('stops when all selected lazy documents cannot be materialized', async () => {
    listKnowledgeAcl.mockResolvedValue([])
    listKnownDocuments.mockResolvedValue([
      { path: 'documents/handbook/a.pdf', version: 1, size: 10 },
      { path: 'documents/handbook/b.pdf', version: 1, size: 20 },
    ])
    fetchDocuments.mockResolvedValue(1)

    await expect(
      prepareWikiMaintenance('team-1', ['documents/handbook/']),
    ).rejects.toThrow('download')
    expect(invoke).not.toHaveBeenCalledWith('kb_maintainer_prepare', expect.anything())
  })

  it('refreshes the visible team tree after publish', async () => {
    invoke.mockResolvedValue({ syncStatus: 'synced' })

    await expect(publishWikiMaintenance('run-1', false)).resolves.toEqual({
      syncStatus: 'synced',
    })

    expect(refreshExternalRoot).toHaveBeenCalledWith('/team/shared/team-sync')
  })
})
