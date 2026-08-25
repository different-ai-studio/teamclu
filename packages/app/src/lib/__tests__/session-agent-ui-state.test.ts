import { describe, it, expect } from 'vitest'
import { AgentStatus, RuntimeLifecycle } from '@/lib/proto/amux_pb'
import {
  isDriftedLocalGhostBinding,
  resolveAgentPillDot,
  resolveSessionAgentSyncHint,
  resolveSessionAgentUiState,
  toMentionDeliverySnapshot,
  type ReachabilityEvidence,
} from '@/lib/session-agent-ui-state'

function evidence(
  status: ReachabilityEvidence['status'],
  startedAt = 10,
  observedAt = startedAt,
): ReachabilityEvidence {
  return {
    status,
    startedAt,
    observedAt,
    requestId: 1,
    contextKey: 'team:context:agent',
  }
}

const draftBase = {
  context: { kind: 'draft' as const },
  isLocalAgent: false,
  presenceOnline: undefined,
  runtimeInfo: undefined,
  availableModelCount: 0,
  isStaleBinding: false,
  connectingTimedOut: false,
}

const sessionBase = {
  context: { kind: 'session' as const, sessionId: 'session-1' },
  isLocalAgent: false,
  presenceOnline: undefined,
  runtimeInfo: undefined,
  availableModelCount: 0,
  isStaleBinding: false,
  connectingTimedOut: false,
}

describe('isDriftedLocalGhostBinding', () => {
  it('detects ghost online retain for a superseded local actor', () => {
    expect(
      isDriftedLocalGhostBinding({
        agentId: 'old-macpro',
        localDaemonActorId: 'new-local',
        presenceOnline: true,
        agentRuntimeInfo: undefined,
        agentAvailableModelCount: 0,
        localRuntimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        localAvailableModelCount: 2,
      }),
    ).toBe(true)
  })

  it('ignores remote offline agents', () => {
    expect(
      isDriftedLocalGhostBinding({
        agentId: 'remote-agent',
        localDaemonActorId: 'local-agent',
        presenceOnline: false,
        agentRuntimeInfo: undefined,
        agentAvailableModelCount: 0,
        localRuntimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        localAvailableModelCount: 2,
      }),
    ).toBe(false)
  })
})

describe('resolveSessionAgentUiState', () => {
  it('lets stale binding win over every other signal', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      isStaleBinding: true,
      activeStreamConfirmed: true,
    })).toBe('stale')
  })

  it('lets an active stream override delayed offline evidence', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      presenceOnline: false,
      reachability: evidence('unreachable'),
      activeStreamConfirmed: true,
    })).toBe('ready')
  })

  it('treats an online remote draft as ready without models', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      presenceOnline: true,
      presenceObservedAt: 20,
    })).toBe('ready')
  })

  it('treats any valid remote RPC response as draft ready', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      reachability: evidence('reachable'),
    })).toBe('ready')
  })

  it('reports explicit offline presence immediately', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      presenceOnline: false,
    })).toBe('offline')
  })

  it('reports a target timeout with unknown presence as draft offline', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      reachability: evidence('unreachable'),
    })).toBe('offline')
  })

  it('does not let a probe started before fresh draft presence override it', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      presenceOnline: true,
      presenceObservedAt: 20,
      reachability: evidence('unreachable', 10, 30),
    })).toBe('ready')
  })

  it('reports a target timeout started after online presence as runtime-error', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      presenceOnline: true,
      presenceObservedAt: 10,
      reachability: evidence('unreachable', 20, 30),
    })).toBe('runtime-error')
  })

  it('keeps indeterminate draft evidence connecting until timeout', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      reachability: evidence('indeterminate'),
    })).toBe('connecting')
    expect(resolveSessionAgentUiState({
      ...draftBase,
      reachability: evidence('indeterminate'),
      connectingTimedOut: true,
    })).toBe('offline')
  })

  it('keeps a cold established session connecting even when the device is online', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      presenceOnline: true,
      presenceObservedAt: 20,
    })).toBe('connecting')
  })

  it('converges a cold established session timeout to runtime-error', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      presenceOnline: true,
      connectingTimedOut: true,
    })).toBe('runtime-error')
  })

  it('does not require models for an ACTIVE session attachment', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      presenceOnline: true,
      runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
    })).toBe('ready')
  })

  it.each([RuntimeLifecycle.FAILED, RuntimeLifecycle.STOPPED])(
    'maps failed or stopped attachment %s to runtime-error',
    (state) => {
      expect(resolveSessionAgentUiState({
        ...sessionBase,
        presenceOnline: true,
        runtimeInfo: { state } as never,
      })).toBe('runtime-error')
    },
  )

  it('does not let a probe started before fresh session evidence override it', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      presenceOnline: true,
      presenceObservedAt: 20,
      runtimeInfo: { state: RuntimeLifecycle.STARTING } as never,
      runtimeObservedAt: 20,
      reachability: evidence('unreachable', 10, 30),
    })).toBe('connecting')
  })

  it('lets a newer remote target timeout surface a session runtime-error', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      presenceOnline: true,
      presenceObservedAt: 10,
      runtimeInfo: { state: RuntimeLifecycle.STARTING } as never,
      runtimeObservedAt: 10,
      reachability: evidence('unreachable', 20, 30),
    })).toBe('runtime-error')
  })

  it('keeps the local draft fast path and catalog terminal states', () => {
    const local = {
      ...draftBase,
      isLocalAgent: true,
      reachability: evidence('reachable'),
    }
    expect(resolveSessionAgentUiState({
      ...local,
      localCatalog: 'ready',
    })).toBe('ready')
    expect(resolveSessionAgentUiState({
      ...local,
      localCatalog: 'empty',
    })).toBe('unconfigured')
    expect(resolveSessionAgentUiState({
      ...local,
      localCatalog: 'error',
    })).toBe('catalog-error')
  })

  it('does not apply the local catalog to a remote draft', () => {
    expect(resolveSessionAgentUiState({
      ...draftBase,
      localCatalog: 'ready',
    })).toBe('connecting')
  })

  it('lets local loopback unreachable veto an ACTIVE session retain', () => {
    expect(resolveSessionAgentUiState({
      ...sessionBase,
      isLocalAgent: true,
      presenceOnline: true,
      runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
      reachability: evidence('unreachable'),
    })).toBe('offline')
  })

  describe('local session — loopback layered over MQTT retain', () => {
    const localSession = {
      ...sessionBase,
      isLocalAgent: true,
      reachability: evidence('reachable'),
    }

    it('stays ready when broker presence drops but loopback and catalog remain', () => {
      expect(resolveSessionAgentUiState({
        ...localSession,
        presenceOnline: false,
        runtimeInfo: undefined,
        localCatalog: 'ready',
        availableModelCount: 3,
      })).toBe('ready')
    })

    it('does not escalate MQTT blip to runtime-error after connecting timeout', () => {
      expect(resolveSessionAgentUiState({
        ...localSession,
        presenceOnline: false,
        runtimeInfo: undefined,
        localCatalog: 'ready',
        availableModelCount: 3,
        connectingTimedOut: true,
      })).toBe('ready')
    })

    it('still reports runtime-error when loopback sees FAILED', () => {
      expect(resolveSessionAgentUiState({
        ...localSession,
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.FAILED } as never,
      })).toBe('runtime-error')
    })

    it('converges local session cold-start timeout to runtime-error like remote', () => {
      expect(resolveSessionAgentUiState({
        ...localSession,
        presenceOnline: true,
        runtimeInfo: { state: RuntimeLifecycle.STARTING } as never,
        connectingTimedOut: true,
      })).toBe('runtime-error')
    })

    it('leaves remote session on the MQTT retain path unchanged', () => {
      expect(resolveSessionAgentUiState({
        ...sessionBase,
        presenceOnline: false,
        runtimeInfo: { state: RuntimeLifecycle.ACTIVE } as never,
        connectingTimedOut: true,
      })).toBe('offline')
    })
  })
})

describe('resolveSessionAgentSyncHint', () => {
  it('is null for non-ready agents', () => {
    expect(resolveSessionAgentSyncHint({
      uiState: 'connecting',
      isLocalAgent: true,
      daemonMqttConnected: false,
      reachability: evidence('reachable'),
    })).toBeNull()
  })

  it('flags degraded when debounced daemon mqtt reads false', () => {
    expect(resolveSessionAgentSyncHint({
      uiState: 'ready',
      isLocalAgent: true,
      daemonMqttConnected: false,
      reachability: evidence('reachable'),
    })).toBe('degraded')
  })

  it('does not degrade on stale broker presence when daemon mqtt is up', () => {
    expect(resolveSessionAgentSyncHint({
      uiState: 'ready',
      isLocalAgent: true,
      daemonMqttConnected: true,
      reachability: evidence('reachable'),
    })).toBeNull()
  })

  it('is null while daemon mqtt status is still unknown', () => {
    expect(resolveSessionAgentSyncHint({
      uiState: 'ready',
      isLocalAgent: true,
      daemonMqttConnected: null,
      reachability: evidence('reachable'),
    })).toBeNull()
  })

  it('ignores remote agents', () => {
    expect(resolveSessionAgentSyncHint({
      uiState: 'ready',
      isLocalAgent: false,
      daemonMqttConnected: false,
      reachability: evidence('reachable'),
    })).toBeNull()
  })
})

describe('toMentionDeliverySnapshot', () => {
  it('does not freeze connecting as offline in message metadata', () => {
    expect(toMentionDeliverySnapshot('connecting')).toBeNull()
  })

  it('does not freeze runtime startup failures as network offline metadata', () => {
    expect(toMentionDeliverySnapshot('runtime-error')).toBeNull()
  })

  it('still records true offline and stale states', () => {
    expect(toMentionDeliverySnapshot('offline')).toBe('offline')
    expect(toMentionDeliverySnapshot('stale')).toBe('stale')
    expect(toMentionDeliverySnapshot('ready')).toBe('ready')
  })
})

describe('resolveAgentPillDot', () => {
  const GRAY = 'bg-muted-foreground/40'
  const GREEN = 'bg-emerald-500'
  const AMBER = 'bg-amber-400'
  const RED = 'bg-red-500'

  describe('local agent — ready via the loopback fast path, no retain', () => {
    it('is green, not gray, when ready with no runtime info at all', () => {
      // The regression this guards: `resolveSessionAgentUiState`'s local fast
      // path returns 'ready' off the loopback catalog alone, so the local agent
      // is the ONLY agent that can be ready with no MQTT retain. Reading the
      // absent retain here painted a gray dot on a pill that was at the same
      // time showing a model name, no status suffix, and a live model picker.
      expect(resolveAgentPillDot('ready', undefined).color).toBe(GREEN)
    })

    it('does not pulse in that state — nothing is in progress', () => {
      expect(resolveAgentPillDot('ready', undefined).pulse).toBe(false)
    })
  })

  describe('retain present — the finer-grained answer wins', () => {
    it('green for an active runtime', () => {
      expect(
        resolveAgentPillDot('ready', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
        } as never).color,
      ).toBe(GREEN)
    })

    it('amber while starting, even though uiState already says ready', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.STARTING } as never).color,
      ).toBe(AMBER)
    })

    it('red for a failed runtime', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.FAILED } as never).color,
      ).toBe(RED)
    })

    it('red for an active runtime reporting an agent error', () => {
      expect(
        resolveAgentPillDot('ready', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.ERROR,
        } as never).color,
      ).toBe(RED)
    })

    it('gray for a stopped runtime', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.STOPPED } as never).color,
      ).toBe(GRAY)
    })

    it('gray for an unknown lifecycle', () => {
      expect(
        resolveAgentPillDot('ready', { state: RuntimeLifecycle.UNKNOWN } as never).color,
      ).toBe(GRAY)
    })
  })

  describe('non-ready states ignore the retain entirely', () => {
    it('offline is gray even with an ACTIVE retain (a ghost the uiState vetoed)', () => {
      expect(
        resolveAgentPillDot('offline', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
        } as never).color,
      ).toBe(GRAY)
    })

    it('stale is red even with an ACTIVE retain', () => {
      expect(
        resolveAgentPillDot('stale', {
          state: RuntimeLifecycle.ACTIVE,
          status: AgentStatus.IDLE,
        } as never).color,
      ).toBe(RED)
    })

    it('connecting is amber with pulse', () => {
      const dot = resolveAgentPillDot('connecting', undefined)
      expect(dot.color).toBe(AMBER)
      expect(dot.pulse).toBe(true)
    })

    it('a failed model probe is red — broken, not merely unset', () => {
      expect(resolveAgentPillDot('catalog-error', undefined).color).not.toBe(AMBER)
    })

    it('unconfigured is amber — a setup gap, not a failure', () => {
      expect(resolveAgentPillDot('unconfigured', undefined).color).toBe(AMBER)
    })
  })

  it('agrees with the pill for every state a remote agent can reach', () => {
    // A remote agent only reaches 'ready' through the ACTIVE branch of
    // resolveSessionAgentUiState, so ready-without-retain is unreachable for it
    // and this change cannot alter any remote dot.
    const remoteReady = resolveSessionAgentUiState({
      context: { kind: 'session', sessionId: 'session-1' },
      isLocalAgent: false,
      presenceOnline: true,
      runtimeInfo: { state: RuntimeLifecycle.ACTIVE, status: AgentStatus.IDLE } as never,
      availableModelCount: 3,
      isStaleBinding: false,
      connectingTimedOut: false,
    })
    expect(remoteReady).toBe('ready')
    expect(
      resolveAgentPillDot(remoteReady, {
        state: RuntimeLifecycle.ACTIVE,
        status: AgentStatus.IDLE,
      } as never).color,
    ).toBe(GREEN)
  })
})
