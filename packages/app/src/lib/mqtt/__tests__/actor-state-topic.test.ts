import { describe, expect, it } from 'vitest'
import { parseActorStateTopic } from '../actor-state-topic'

describe('parseActorStateTopic', () => {
  it('parses an actor presence topic', () => {
    expect(
      parseActorStateTopic('amux/48f2fbbb-bca1-41d1-b262-070982ba5a70/c330b4f8-e626-47f2-99a9-e91dc3b47f8c/state'),
    ).toEqual({
      teamId: '48f2fbbb-bca1-41d1-b262-070982ba5a70',
      actorId: 'c330b4f8-e626-47f2-99a9-e91dc3b47f8c',
    })
  })

  it('ignores the legacy desktop last-will topics, keyed by a client id', () => {
    // Retained JSON `{"status":"offline"}` left by desktops before the fix.
    expect(parseActorStateTopic('amux/team-1/teamclu-ad103c7a-f27eaed0/state')).toBeNull()
  })

  it('rejects other shapes', () => {
    expect(parseActorStateTopic('amux/team-1/actor-1/runtime/rt-1/state')).toBeNull()
    expect(parseActorStateTopic('amux/team-1/actor-1/status')).toBeNull()
    expect(parseActorStateTopic('amux//actor-1/state')).toBeNull()
    expect(parseActorStateTopic('amux/team-1//state')).toBeNull()
    expect(parseActorStateTopic('other/team-1/actor-1/state')).toBeNull()
  })
})
