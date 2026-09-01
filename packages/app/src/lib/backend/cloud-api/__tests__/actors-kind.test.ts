/**
 * `kind` on /v1/teams/:id/actors is matched against `actor_type` verbatim by
 * both backends (`eq(actorDirectory.actorType, kind)` / `.eq("actor_type", kind)`).
 *
 * `actor_type` only ever holds member / agent / external. Asking for anything
 * else is not an error anywhere in the stack: PostgREST happily returns zero
 * rows, the endpoint answers 200, and the caller renders an empty list. That is
 * how `kind=user` survived here long enough to silently empty every member
 * picker in the app.
 *
 * So this asserts the literal, which is the only place the mistake is visible.
 */
import { describe, it, expect, vi } from 'vitest'
import { createActorsModule } from '../actors'

const ACTOR_TYPES = ['member', 'agent', 'external'] as const

describe('actors module: kind values must exist in actor_type', () => {
  it('listTeamMembersForAccess asks for members, not a made-up type', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] })
    const actors = createActorsModule({ get } as never)

    await actors.listTeamMembersForAccess('team-1')

    expect(get).toHaveBeenCalledTimes(1)
    const url = String(get.mock.calls[0][0])
    const kind = new URL(url, 'https://x.local').searchParams.get('kind')
    expect(
      ACTOR_TYPES.includes(kind as (typeof ACTOR_TYPES)[number]),
      `kind=${kind} does not exist in actor_type; the request would return zero rows`,
    ).toBe(true)
    expect(kind).toBe('member')
  })
})
