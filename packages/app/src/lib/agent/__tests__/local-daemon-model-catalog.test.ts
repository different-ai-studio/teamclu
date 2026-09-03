import { describe, expect, it, vi, beforeEach } from 'vitest'
import { create } from '@bufbuild/protobuf'

const getDaemonModelCatalog = vi.hoisted(() => vi.fn())

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  getDaemonModelCatalog,
  encodeWorkspaceId: (p: string) => `enc(${p})`,
}))
vi.mock('@/lib/session/session-flow-log', () => ({ sessionFlowLog: vi.fn() }))

import { ModelInfoSchema, RuntimeInfoSchema, RuntimeLifecycle } from '@/lib/proto/amux_pb'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'
import {
  fetchLocalDaemonCatalog,
  mergeLocalDaemonModels,
  seedLocalDaemonModelsInBackground,
} from '@/lib/agent/local-daemon-model-catalog'

const catalog = (backend: string, refs: string[], recentModels?: string[]) => ({
  automation_default_backend: backend,
  backends: [
    {
      backend,
      label: backend,
      models: refs.map((ref) => ({ ref, model_id: ref, display_name: ref })),
      ...(recentModels ? { recent_models: recentModels } : {}),
    },
  ],
})

async function modelsFor(
  workspacePath: string,
  backendType: string | null | undefined,
) {
  const outcome = await fetchLocalDaemonCatalog(workspacePath, backendType)
  return outcome.status === 'models' ? outcome.models : null
}

describe('fetchLocalDaemonCatalog model groups', () => {
  beforeEach(() => {
    getDaemonModelCatalog.mockReset()
  })

  it('returns the group for each implemented backend', async () => {
    // All four backends must resolve over HTTP; cursor and claude used to get no
    // group at all from this endpoint.
    for (const [backendType, groupId] of [
      ['opencode', 'opencode'],
      ['pi', 'pi'],
      ['cursor', 'cursor'],
      ['claude-code', 'claude-code'],
    ] as const) {
      getDaemonModelCatalog.mockResolvedValueOnce(catalog(groupId, ['prov/a', 'prov/b']))
      const models = await modelsFor('/w1', backendType)
      expect(models, `${backendType} should resolve models`).toHaveLength(2)
      expect(models?.[0].id).toBe('prov/a')
      expect(models?.[0].providerName).toBe('prov')
    }
  })

  it('groups Pi catalog entries by their model provider, not the Pi runner', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce(
      catalog('pi', ['deepseek/deepseek-v4-flash', 'kimi-coding/k3']),
    )

    const models = await modelsFor('/w1', 'pi')

    expect(models?.map((model) => model.providerName)).toEqual(['deepseek', 'kimi-coding'])
  })

  it('maps every claude spelling onto the daemon "claude-code" wire name', async () => {
    // The group id is `agent_type_name(ClaudeCode)` = "claude-code", not the
    // launch-config `backend_type` spelling "claude".
    for (const spelling of ['claude', 'claude_code', 'claude-code']) {
      getDaemonModelCatalog.mockResolvedValueOnce(catalog('claude-code', ['anthropic/opus']))
      const models = await modelsFor('/w1', spelling)
      expect(models, `${spelling} should resolve`).toHaveLength(1)
    }
  })

  it('accepts the sole group when the client backend type is stale', async () => {
    // Single-agent mode serves one group; discarding it over a name mismatch
    // would throw away the only catalog available.
    getDaemonModelCatalog.mockResolvedValue(catalog('pi', ['pi/x']))
    expect(await modelsFor('/w1', 'opencode')).toHaveLength(1)
    expect(await modelsFor('/w1', null)).toHaveLength(1)
  })

  it('returns null when the daemon is unreachable, empty, or the path is blank', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce(null)
    expect(await modelsFor('/w1', 'opencode')).toBeNull()

    getDaemonModelCatalog.mockResolvedValueOnce(catalog('opencode', []))
    expect(await modelsFor('/w1', 'opencode')).toBeNull()

    expect(await modelsFor('   ', 'opencode')).toBeNull()
  })

  it('does not guess when several groups are offered and none matches', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce({
      automation_default_backend: 'pi',
      backends: [
        { backend: 'pi', label: 'Pi', models: [{ ref: 'pi/x', model_id: 'x', display_name: 'x' }] },
        {
          backend: 'cursor',
          label: 'Cursor',
          models: [{ ref: 'cursor/y', model_id: 'y', display_name: 'y' }],
        },
      ],
    })
    expect(await modelsFor('/w1', 'opencode')).toBeNull()
  })
})

describe('fetchLocalDaemonCatalog', () => {
  beforeEach(() => {
    getDaemonModelCatalog.mockReset()
  })

  it('separates "no answer" from "answered with nothing"', async () => {
    // The distinction the whole first-install fix rests on: collapsing these
    // two into one null is what made a fresh install look like a slow one.
    getDaemonModelCatalog.mockResolvedValueOnce(null)
    expect(await fetchLocalDaemonCatalog('/w1', 'opencode')).toEqual({ status: 'unknown' })

    getDaemonModelCatalog.mockResolvedValueOnce(catalog('opencode', []))
    expect(await fetchLocalDaemonCatalog('/w1', 'opencode')).toEqual({
      status: 'empty',
      backend: 'opencode',
    })
  })

  it('treats an ambiguous multi-group reply as unknown, never as empty', async () => {
    // Several groups and none matches is "we cannot tell", not "nothing is
    // configured" — reporting empty here would wrongly blame the user's setup.
    getDaemonModelCatalog.mockResolvedValueOnce({
      automation_default_backend: 'pi',
      backends: [
        { backend: 'pi', label: 'Pi', models: [] },
        { backend: 'cursor', label: 'Cursor', models: [] },
      ],
    })
    expect(await fetchLocalDaemonCatalog('/w1', 'opencode')).toEqual({ status: 'unknown' })
  })

  it('takes the daemon automation default when the caller names no backend', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce({
      automation_default_backend: 'cursor',
      backends: [
        { backend: 'pi', label: 'Pi', models: [{ ref: 'pi/x', model_id: 'x', display_name: 'x' }] },
        {
          backend: 'cursor',
          label: 'Cursor',
          models: [{ ref: 'cursor/y', model_id: 'y', display_name: 'y' }],
        },
      ],
    })
    const outcome = await fetchLocalDaemonCatalog('/w1')
    expect(outcome.status).toBe('models')
    expect(outcome.status === 'models' && outcome.backend).toBe('cursor')
  })


})

describe('mergeLocalDaemonModels', () => {
  const models = [create(ModelInfoSchema, { id: 'prov/http', displayName: 'From HTTP' })]

  const seedEntry = (runtimeId: string, actorId: string, availableModels: unknown[] = []) => {
    useRuntimeStateStore.getState().upsert(
      runtimeId,
      actorId,
      create(RuntimeInfoSchema, {
        runtimeId,
        state: RuntimeLifecycle.ACTIVE,
        availableModels: availableModels as never,
      }),
    )
  }

  beforeEach(() => {
    useRuntimeStateStore.getState().clear()
  })

  it('fills an empty catalog on the composite attachment key', () => {
    seedEntry('actor-1::session-1', 'actor-1')
    expect(
      mergeLocalDaemonModels({
        daemonActorId: 'actor-1',
        runtimeId: 'rt-1',
        sessionId: 'session-1',
        models,
      }),
    ).toBe(true)

    const state = useRuntimeStateStore.getState().byRuntimeId
    expect(state['actor-1::session-1'].info.availableModels[0].id).toBe('prov/http')
  })

  it('leaves a retain that already carries models alone', () => {
    seedEntry('rt-1', 'actor-1', [create(ModelInfoSchema, { id: 'prov/from-retain' })])
    expect(
      mergeLocalDaemonModels({ daemonActorId: 'actor-1', runtimeId: 'rt-1', models }),
    ).toBe(false)
    expect(
      useRuntimeStateStore.getState().byRuntimeId['rt-1'].info.availableModels[0].id,
    ).toBe('prov/from-retain')
  })


  it('ignores an MRU entry the catalog no longer offers', () => {
    seedEntry('rt-1', 'actor-1')
    mergeLocalDaemonModels({
      daemonActorId: 'actor-1',
      runtimeId: 'rt-1',
      models,
      recentModels: ['prov/retired'],
    })
    expect(useRuntimeStateStore.getState().byRuntimeId['rt-1'].info.currentModel).toBe('')
  })

  it('never overwrites a currentModel the retain already named', () => {
    useRuntimeStateStore.getState().upsert(
      'rt-1',
      'actor-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'rt-1',
        state: RuntimeLifecycle.ACTIVE,
        currentModel: 'prov/from-retain',
        availableModels: [],
      }),
    )
    mergeLocalDaemonModels({
      daemonActorId: 'actor-1',
      runtimeId: 'rt-1',
      models,
      recentModels: ['prov/http'],
    })
    expect(useRuntimeStateStore.getState().byRuntimeId['rt-1'].info.currentModel).toBe(
      'prov/from-retain',
    )
  })

  it('does nothing without an existing entry or without models', () => {
    expect(
      mergeLocalDaemonModels({ daemonActorId: 'actor-1', runtimeId: 'missing', models }),
    ).toBe(false)

    seedEntry('rt-1', 'actor-1')
    expect(
      mergeLocalDaemonModels({ daemonActorId: 'actor-1', runtimeId: 'rt-1', models: [] }),
    ).toBe(false)
  })
})

describe('seedLocalDaemonModelsInBackground', () => {
  beforeEach(() => {
    getDaemonModelCatalog.mockReset()
    useRuntimeStateStore.getState().clear()
  })

  it('merges HTTP catalog onto the composite attachment key', async () => {
    useRuntimeStateStore.getState().upsert(
      'actor-1::session-1',
      'actor-1',
      create(RuntimeInfoSchema, {
        runtimeId: 'session-1',
        state: RuntimeLifecycle.ACTIVE,
        availableModels: [],
      }),
    )
    getDaemonModelCatalog.mockResolvedValue(
      catalog('opencode', ['prov/http']),
    )

    seedLocalDaemonModelsInBackground({
      daemonActorId: 'actor-1',
      runtimeId: 'rt-1',
      sessionId: 'session-1',
      workspacePath: '/w1',
      backendType: 'opencode',
    })

    await vi.waitFor(() => {
      expect(
        useRuntimeStateStore.getState().byRuntimeId['actor-1::session-1']?.info.availableModels,
      ).toHaveLength(1)
    })
    expect(
      useRuntimeStateStore.getState().byRuntimeId['actor-1::session-1']?.info.availableModels[0]?.id,
    ).toBe('prov/http')
    expect(useRuntimeStateStore.getState().byRuntimeId['rt-1']).toBeUndefined()
  })
})
