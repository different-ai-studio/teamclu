import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDaemonRuntime: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: mocks.isTauri,
}))

vi.mock('@/lib/daemon-local-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/daemon-local-client')>()
  return {
    ...actual,
    encodeWorkspaceId: (path: string) => `id:${path}`,
    getDaemonRuntime: mocks.getDaemonRuntime,
  }
})

import { useWorkspaceRuntimeRefreshStore } from '../workspace-runtime-refresh'

describe('workspace-runtime-refresh store', () => {
  beforeEach(() => {
    mocks.getDaemonRuntime.mockReset()
    mocks.isTauri.mockReturnValue(true)
    useWorkspaceRuntimeRefreshStore.getState().stopPolling()
  })

  it('polls runtime refresh state for the active workspace', async () => {
    mocks.getDaemonRuntime.mockResolvedValue({
      workspace_id: 'id:/tmp/ws',
      ready: true,
      backend: 'opencode',
      current_model: null,
      refresh: {
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-06-03T00:00:00Z',
        last_error: null,
      },
    })

    useWorkspaceRuntimeRefreshStore.getState().startPolling('/tmp/ws')
    await vi.waitFor(() => {
      expect(useWorkspaceRuntimeRefreshStore.getState().refresh?.status).toBe('pending')
    })

    expect(mocks.getDaemonRuntime).toHaveBeenCalledWith('id:/tmp/ws')
  })

  it('noteLocalRefresh sets optimistic pending state', () => {
    useWorkspaceRuntimeRefreshStore.getState().startPolling('/tmp/ws')
    useWorkspaceRuntimeRefreshStore.getState().noteLocalRefresh(['skills'])
    expect(useWorkspaceRuntimeRefreshStore.getState().refresh?.status).toBe('pending')
    expect(useWorkspaceRuntimeRefreshStore.getState().refresh?.change_kinds).toEqual(['skills'])
    expect(useWorkspaceRuntimeRefreshStore.getState().refresh?.recommended_action).toBe('none')
  })

  it('dismissBanner hides pending until a newer change is detected', async () => {
    mocks.getDaemonRuntime.mockResolvedValue({
      workspace_id: 'id:/tmp/ws',
      ready: true,
      backend: 'opencode',
      current_model: null,
      refresh: {
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-06-03T00:00:00Z',
        last_error: null,
      },
    })

    useWorkspaceRuntimeRefreshStore.getState().startPolling('/tmp/ws')
    await vi.waitFor(() => {
      expect(useWorkspaceRuntimeRefreshStore.getState().refresh?.status).toBe('pending')
    })

    useWorkspaceRuntimeRefreshStore.getState().dismissBanner()
    expect(useWorkspaceRuntimeRefreshStore.getState().dismissedAt).toBe('2026-06-03T00:00:00Z')
  })
})
