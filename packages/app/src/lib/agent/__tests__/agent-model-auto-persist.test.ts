import { describe, expect, it } from 'vitest'
import { resolveAutoPersistModelId } from '@/lib/agent/agent-model-auto-persist'

const LOCAL = 'local-daemon-actor'
const MRU_HEAD = 'minimax-cn/MiniMax-M2.7'
const LIST_HEAD = 'anthropic/claude-fable-5'

/** Cold start on the local agent: catalog settled, MRU known, nothing else set. */
function base(overrides: Partial<Parameters<typeof resolveAutoPersistModelId>[0]> = {}) {
  return resolveAutoPersistModelId({
    sessionId: 'sess-1',
    uiState: 'ready',
    runtimeInfoLoading: false,
    availableModelIds: [LIST_HEAD, 'anthropic/claude-haiku', MRU_HEAD],
    existingPick: undefined,
    sessionEstablishedModel: null,
    retainCurrentModel: null,
    localDaemonActorId: LOCAL,
    agentId: LOCAL,
    localCatalogStatus: 'ready',
    localRecentModel: MRU_HEAD,
    ...overrides,
  })
}

describe('resolveAutoPersistModelId', () => {
  it('persists the device MRU, not the first model in the list', () => {
    // The user's report: "每次重启都会回到模型列表的第一个". Every restart makes
    // a new session, so this is the path that decides it.
    expect(base()).toBe(MRU_HEAD)
  })

  it('writes nothing when this client has no history to honour', () => {
    // Used to return `availableModelIds[0]` here. A pick is durable and
    // outranks every later signal, so that guess got pinned for good — and
    // `available` is ordered by provider probe order, which is not stable.
    // The answer with no history is now "ask the user" (ADR-0007).
    expect(base({ localRecentModel: '' })).toBeNull()
  })

  describe('refuses to write while an input is merely not-yet-known', () => {
    // These are the two holes that let the wrong model get pinned despite a
    // guard being present. Both look like "known absent" but mean "unknown".

    it('waits when the loopback catalog has no entry yet', () => {
      // undefined = no probe result recorded. A guard that only checked
      // 'pending' sailed straight through the very first render.
      expect(base({ localCatalogStatus: undefined })).toBeNull()
      expect(base({ localCatalogStatus: 'pending' })).toBeNull()
    })
  })

  it('does not stall forever when this device has no local daemon at all', () => {
    // Outside Tauri (web build, tests) the identity never resolves. An earlier
    // guard blocked on null and so persisted nothing for ANY agent, ever —
    // trading the pinned-wrong-model bug for a never-pinned one. The caller
    // passes the persisted id, so null here means "no local daemon on this
    // device", not "ask again later".
    expect(base({ localDaemonActorId: null, localCatalogStatus: undefined })).toBe(MRU_HEAD)
  })

  it('does not gate a remote agent on this device\'s catalog probe', () => {
    // The loopback catalog says nothing about another machine, so it must not
    // make a remote agent *wait*. With history it writes immediately...
    expect(
      base({
        agentId: 'some-remote-agent',
        localCatalogStatus: undefined,
        localRecentModel: 'remembered/model',
      }),
    ).toBe('remembered/model')
    // ...and without history it declines outright rather than guessing, same
    // as the local agent.
    expect(
      base({
        agentId: 'some-remote-agent',
        localCatalogStatus: undefined,
        localRecentModel: '',
      }),
    ).toBeNull()
  })

  it('never overrides an answer that already has more authority', () => {
    expect(base({ existingPick: 'user/chose-this' })).toBeNull()
    expect(base({ sessionEstablishedModel: 'transcript/model' })).toBeNull()
    expect(base({ retainCurrentModel: 'retain/model' })).toBeNull()
  })

  it('writes nothing when the agent cannot run anything', () => {
    for (const uiState of ['offline', 'stale', 'runtime-error', 'unconfigured'] as const) {
      expect(base({ uiState }), uiState).toBeNull()
    }
  })

  it('writes nothing without a session, a catalog, or while it is loading', () => {
    expect(base({ sessionId: '   ' })).toBeNull()
    expect(base({ availableModelIds: [] })).toBeNull()
    expect(base({ runtimeInfoLoading: true })).toBeNull()
  })

  it('stops waiting once the probe has settled, but still refuses to guess', () => {
    // 'unknown' / 'empty' mean we asked and learned nothing. That ends the
    // wait — but a settled probe is not a model, so with no history there is
    // still nothing to write.
    expect(base({ localCatalogStatus: 'unknown', localRecentModel: '' })).toBeNull()
    expect(base({ localCatalogStatus: 'empty', localRecentModel: '' })).toBeNull()
    // Settled + history = write, which is what "stops waiting" buys.
    expect(base({ localCatalogStatus: 'unknown', localRecentModel: 'mru/model' })).toBe(
      'mru/model',
    )
  })
})
