import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { loadDeviceModelOptions, loadLlmConfig, loadGatewayModel } = vi.hoisted(() => ({
  loadDeviceModelOptions: vi.fn(),
  loadLlmConfig: vi.fn(),
  loadGatewayModel: vi.fn(),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (state: { team: { id: string } | null }) => unknown) =>
    selector({ team: { id: 'team-1' } }),
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  getCurrentDaemonWorkspaceAgent: vi.fn().mockResolvedValue(null),
  listDaemonWorkspaces: vi.fn(),
}))

vi.mock('@/lib/daemon/amuxd-channels', () => ({
  loadGatewayModel,
}))

vi.mock('@/lib/agent/device-default-models', () => ({
  loadDeviceModelOptions,
}))

vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({
    teamWorkspaceConfig: { loadLlmConfig },
  }),
}))

import { useChannelRuntimeDefaults } from '../use-channel-runtime-defaults'

describe('useChannelRuntimeDefaults', () => {
  beforeEach(() => {
    loadDeviceModelOptions.mockReset()
    loadLlmConfig.mockReset()
    loadGatewayModel.mockReset()
    loadGatewayModel.mockResolvedValue('anthropic/claude-sonnet')
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
      models: [{ id: 'glm-4.6', name: '标准' }],
    })
  })

  it('offers the same models as wiki maintenance, including the team gateway', async () => {
    const { result } = renderHook(() => useChannelRuntimeDefaults())

    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.models).toEqual([
      { id: 'anthropic/claude-sonnet', displayName: 'Claude Sonnet', providerName: 'anthropic' },
      { id: 'team/glm-4.6', displayName: '标准', providerName: 'team' },
    ])
  })
})
