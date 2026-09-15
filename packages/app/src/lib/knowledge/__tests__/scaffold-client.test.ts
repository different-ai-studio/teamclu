import { describe, it, expect, vi, beforeEach } from 'vitest'

const { daemonRequest } = vi.hoisted(() => ({
  daemonRequest: vi.fn(),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  daemonRequest: (...args: unknown[]) => daemonRequest(...args),
}))

import { scaffoldKnowledgeVault } from '../scaffold-client'

describe('scaffoldKnowledgeVault', () => {
  beforeEach(() => {
    daemonRequest.mockReset()
    daemonRequest.mockResolvedValue({
      knowledgeRoot: '/k',
      dirsCreated: [],
      filesCreated: ['00-home.md'],
      filesSkipped: [],
    })
  })

  it('POSTs teamName to the daemon scaffold endpoint', async () => {
    await scaffoldKnowledgeVault({ teamName: '增长组' })
    expect(daemonRequest).toHaveBeenCalledWith('/v1/knowledge/scaffold', {
      method: 'POST',
      body: JSON.stringify({ teamName: '增长组' }),
    })
  })

  it('omits blank teamName', async () => {
    await scaffoldKnowledgeVault({ teamName: '  ' })
    expect(daemonRequest).toHaveBeenCalledWith('/v1/knowledge/scaffold', {
      method: 'POST',
      body: JSON.stringify({ teamName: undefined }),
    })
  })
})
