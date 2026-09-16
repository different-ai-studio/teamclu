import { describe, expect, it } from 'vitest'
import { createTeamsModule } from '@/lib/backend/cloud-api/teams'
import type { CloudApiClient } from '@/lib/backend/cloud-api/http'

function mockClient(): CloudApiClient & { calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  return {
    calls,
    async get() { throw new Error('unexpected get') },
    async post() { throw new Error('unexpected post') },
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body })
      return undefined as never
    },
    async put() { throw new Error('unexpected put') },
    async delete() { throw new Error('unexpected delete') },
    async postRaw() { throw new Error('unexpected postRaw') },
    async getRaw() { throw new Error('unexpected getRaw') },
  }
}

describe('teams.setTeamMemberRole', () => {
  it('PATCHes the member with the new role', async () => {
    const client = mockClient()
    await createTeamsModule(client).setTeamMemberRole('team-1', 'actor-b', 'admin')
    expect(client.calls).toEqual([
      {
        method: 'PATCH',
        path: '/v1/teams/team-1/members/actor-b',
        body: { role: 'admin' },
      },
    ])
  })
})
