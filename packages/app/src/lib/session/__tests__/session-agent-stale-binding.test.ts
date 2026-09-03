import { describe, it, expect, beforeEach } from 'vitest'
import { RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  __resetLocalDaemonIdentityForTest,
  noteLocalDaemonActorId,
} from '@/lib/daemon/local-daemon-identity'
import { resolveEngagedAgentStaleBinding } from '@/lib/session/session-agent-stale-binding'
import { appShortName } from '@/lib/config/build-config'

const STORAGE_KEY = `${appShortName}-local-daemon-actor-id`
const activeRuntime = { state: RuntimeLifecycle.ACTIVE } as never

function ghostBindingInput(agentId: string) {
  return {
    agentId,
    localDaemonActorId: 'invitee-local',
    presenceOnline: true as const,
    agentRuntimeInfo: undefined,
    agentAvailableModelCount: 0,
    localRuntimeInfo: activeRuntime,
    localAvailableModelCount: 2,
  }
}

describe('resolveEngagedAgentStaleBinding', () => {
  beforeEach(() => {
    __resetLocalDaemonIdentityForTest()
    noteLocalDaemonActorId('invitee-local')
  })

  it('does not mark remote teammate agent as stale', () => {
    expect(resolveEngagedAgentStaleBinding(ghostBindingInput('creator-gg-bot'))).toBe(false)
  })

  it('marks superseded local agent as stale', () => {
    noteLocalDaemonActorId('old-macpro')
    noteLocalDaemonActorId('new-local')
    expect(resolveEngagedAgentStaleBinding(ghostBindingInput('old-macpro'))).toBe(true)
  })

  it('marks superseded local agent as stale without ghost MQTT conditions', () => {
    noteLocalDaemonActorId('old-macpro')
    noteLocalDaemonActorId('new-local')
    expect(
      resolveEngagedAgentStaleBinding({
        agentId: 'old-macpro',
        localDaemonActorId: 'new-local',
        presenceOnline: false,
        agentRuntimeInfo: undefined,
        agentAvailableModelCount: 0,
        localRuntimeInfo: undefined,
        localAvailableModelCount: 0,
      }),
    ).toBe(true)
  })

  it('marks transition-window local id as stale when ghost MQTT retains', () => {
    localStorage.setItem(STORAGE_KEY, 'old-macpro')
    noteLocalDaemonActorId('new-local')
    expect(
      resolveEngagedAgentStaleBinding({
        ...ghostBindingInput('old-macpro'),
        localDaemonActorId: 'new-local',
      }),
    ).toBe(true)
  })

  it('does not mark the current local agent stale after switching back', () => {
    noteLocalDaemonActorId('kfc')
    noteLocalDaemonActorId('other-team')
    noteLocalDaemonActorId('kfc')
    expect(
      resolveEngagedAgentStaleBinding({
        agentId: 'kfc',
        localDaemonActorId: 'kfc',
        presenceOnline: true,
        agentRuntimeInfo: activeRuntime,
        agentAvailableModelCount: 2,
        localRuntimeInfo: activeRuntime,
        localAvailableModelCount: 2,
      }),
    ).toBe(false)
  })
})
