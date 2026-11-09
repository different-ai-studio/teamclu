import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadDeviceModelOptions, loadLlmConfig } = vi.hoisted(() => ({
  loadDeviceModelOptions: vi.fn(),
  loadLlmConfig: vi.fn(),
}))

vi.mock('@/lib/agent/device-default-models', () => ({
  loadDeviceModelOptions,
}))

vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    teamWorkspaceConfig: { loadLlmConfig },
  }),
}))

import { groupModelsByProvider, loadSelectableModels } from '../selectable-models'

describe('loadSelectableModels', () => {
  beforeEach(() => {
    loadDeviceModelOptions.mockReset()
    loadLlmConfig.mockReset()
  })

  it('lists the same device and team-gateway models the wiki compiler can use', async () => {
    loadDeviceModelOptions.mockResolvedValue({
      options: [
        {
          id: 'anthropic/claude-sonnet',
          displayName: 'Claude Sonnet',
          providerName: 'anthropic',
          backend: 'pi',
        },
      ],
      reason: 'ok',
      defaultBackend: 'pi',
    })
    loadLlmConfig.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://gateway.example/v1',
      models: [
        { id: 'glm-4.6', name: '标准' },
        { id: 'glm-4-flash', name: '快速' },
      ],
    })

    await expect(loadSelectableModels('team-1')).resolves.toEqual([
      { id: 'anthropic/claude-sonnet', displayName: 'Claude Sonnet', providerName: 'anthropic' },
      { id: 'team/glm-4.6', displayName: '标准', providerName: 'team' },
      { id: 'team/glm-4-flash', displayName: '快速', providerName: 'team' },
    ])
    expect(loadDeviceModelOptions).toHaveBeenCalledWith('team-1')
    expect(loadLlmConfig).toHaveBeenCalledWith('team-1')
  })

  it('skips team models when the team gateway is disabled', async () => {
    loadDeviceModelOptions.mockResolvedValue({
      options: [],
      reason: 'no-models',
      defaultBackend: null,
    })
    loadLlmConfig.mockResolvedValue({ enabled: false, baseUrl: null, models: [{ id: 'glm-4.6', name: '标准' }] })

    await expect(loadSelectableModels('team-1')).resolves.toEqual([])
  })
})

describe('groupModelsByProvider', () => {
  it('keeps provider order and leaves unscoped models ungrouped', () => {
    expect(
      groupModelsByProvider([
        { id: 'anthropic/claude-sonnet', providerName: 'anthropic' },
        { id: 'team/glm-4.6', providerName: 'team' },
        { id: 'anthropic/claude-haiku', providerName: 'anthropic' },
        { id: 'bare-model' },
      ]),
    ).toEqual([
      {
        label: 'anthropic',
        models: [
          { id: 'anthropic/claude-sonnet', providerName: 'anthropic' },
          { id: 'anthropic/claude-haiku', providerName: 'anthropic' },
        ],
      },
      { label: 'team', models: [{ id: 'team/glm-4.6', providerName: 'team' }] },
      { label: '', models: [{ id: 'bare-model' }] },
    ])
  })
})
