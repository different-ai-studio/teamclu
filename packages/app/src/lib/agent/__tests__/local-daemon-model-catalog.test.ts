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

  it('resolves the pi catalog group for any legacy backend label', async () => {
    for (const backendType of ['opencode', 'pi', 'cursor', 'claude-code', 'claude', 'claude_code']) {
      getDaemonModelCatalog.mockResolvedValueOnce(catalog('pi', ['prov/a', 'prov/b']))
      const models = await modelsFor('/w1', backendType)
      expect(models, `${backendType} should resolve pi models`).toHaveLength(2)
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

  it('maps legacy claude spellings onto the pi catalog slice', async () => {
    for (const spelling of ['claude', 'claude_code', 'claude-code']) {
      getDaemonModelCatalog.mockResolvedValueOnce(catalog('pi', ['anthropic/opus']))
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

    getDaemonModelCatalog.mockResolvedValueOnce(catalog('pi', []))
    expect(await modelsFor('/w1', 'opencode')).toBeNull()

    expect(await modelsFor('   ', 'opencode')).toBeNull()
  })

  it('returns null when the pi slice is missing from a multi-backend catalog', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce({
      automation_default_backend: 'cursor',
      backends: [
        {
          backend: 'cursor',
          label: 'Cursor',
          models: [{ ref: 'cursor/y', model_id: 'y', display_name: 'y' }],
        },
        {
          backend: 'opencode',
          label: 'OpenCode',
          models: [{ ref: 'opencode/x', model_id: 'x', display_name: 'x' }],
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

    getDaemonModelCatalog.mockResolvedValueOnce(catalog('pi', []))
    expect(await fetchLocalDaemonCatalog('/w1', 'opencode')).toEqual({
      status: 'empty',
      backend: 'pi',
    })
  })

  it('reports unknown when the pi slice is absent from a multi-group catalog', async () => {
    getDaemonModelCatalog.mockResolvedValueOnce({
      automation_default_backend: 'cursor',
      backends: [
        { backend: 'cursor', label: 'Cursor', models: [] },
        { backend: 'opencode', label: 'OpenCode', models: [] },
      ],
    })
    expect(await fetchLocalDaemonCatalog('/w1', 'opencode')).toEqual({ status: 'unknown' })
  })

  it('selects the pi slice when the caller names no backend', async () => {
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
    expect(outcome.status === 'models' && outcome.backend).toBe('pi')
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
      catalog('pi', ['prov/http']),
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
