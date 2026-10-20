import { describe, expect, it, vi } from 'vitest'

import { createWikiMaintainerModule } from '../wiki-maintainer'
import type { CloudApiClient } from '../http'

describe('cloud Wiki maintainer module', () => {
  it('uses generation CAS endpoints for checkpoint and publish', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ generation: 0, stage: 'idle' }),
      put: vi.fn().mockResolvedValue({ version: 1, config: {} }),
      post: vi.fn().mockResolvedValue({ generation: 1 }),
    } as unknown as CloudApiClient
    const api = createWikiMaintainerModule(client)

    await api.getStatus('team/a')
    await api.putConfig('team/a', { expectedVersion: 0, config: { sources: [] } })
    await api.prepareCheckpoint('team/a', {
      expectedGeneration: 0,
      configVersion: 1,
      sha256: 'a'.repeat(64),
      size: 10,
    })
    await api.completeCheckpoint('team/a', {
      expectedGeneration: 0,
      configVersion: 1,
      sha256: 'a'.repeat(64),
      size: 10,
      objectKey: 'wiki-maintainer/object.zip',
      manifest: {},
    })
    await api.beginPublish('team/a', {
      generation: 1,
      configVersion: 1,
      targetCommit: 'b'.repeat(40),
      targetTreeHash: 'c'.repeat(64),
      baseTreeHash: null,
      nodeId: 'node-a',
    })

    expect(client.get).toHaveBeenCalledWith('/v1/teams/team%2Fa/wiki-maintainer')
    expect(client.put).toHaveBeenCalledWith(
      '/v1/teams/team%2Fa/wiki-maintainer/config',
      expect.objectContaining({ expectedVersion: 0 }),
    )
    expect(client.post).toHaveBeenCalledWith(
      '/v1/teams/team%2Fa/wiki-maintainer/checkpoints/prepare',
      expect.objectContaining({ expectedGeneration: 0 }),
    )
    expect(client.post).toHaveBeenCalledWith(
      '/v1/teams/team%2Fa/wiki-maintainer/checkpoints/complete',
      expect.objectContaining({ objectKey: 'wiki-maintainer/object.zip' }),
    )
    expect(client.post).toHaveBeenCalledWith(
      '/v1/teams/team%2Fa/wiki-maintainer/publish/begin',
      expect.objectContaining({ generation: 1 }),
    )
  })
})
