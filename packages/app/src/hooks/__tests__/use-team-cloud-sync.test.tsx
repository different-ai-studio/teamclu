import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
  }),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))

const { toastError, toastWarning, ossSyncNow, state } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  ossSyncNow: vi.fn(() => Promise.resolve()),
  state: { syncing: false, lastError: null as string | null, failed: 0 },
}))

vi.mock('sonner', () => ({ toast: { error: toastError, warning: toastWarning } }))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { workspacePath: string | null }) => unknown) =>
    sel({ workspacePath: null }),
}))

vi.mock('@/stores/oss-sync', () => {
  const full = () => ({ ...state, syncNow: ossSyncNow })
  const store = (sel: (s: ReturnType<typeof full>) => unknown) => sel(full())
  store.getState = full
  return { useOssSyncStore: store }
})

import { useTeamCloudSync } from '../use-team-cloud-sync'

beforeEach(() => {
  vi.clearAllMocks()
  state.syncing = false
  state.lastError = null
  state.failed = 0
})

describe('useTeamCloudSync', () => {
  it('reports a clean sync without a word', async () => {
    const { result } = renderHook(() => useTeamCloudSync())
    await act(async () => {
      await result.current.syncNow()
    })

    expect(ossSyncNow).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('does not pass off a tick that left files behind as a success', async () => {
    // The daemon returns Ok with `failed > 0` — files it could not decode or
    // download, retried on every tick. Saying nothing here is exactly how a
    // permanently stuck knowledge base went unnoticed.
    state.failed = 2
    const { result } = renderHook(() => useTeamCloudSync())
    await act(async () => {
      await result.current.syncNow()
    })

    expect(toastWarning).toHaveBeenCalledWith(
      expect.stringContaining('2 files still cannot sync'),
    )
  })

  it('reports a hard failure as an error, not a warning', async () => {
    state.lastError = 'daemon unreachable'
    const { result } = renderHook(() => useTeamCloudSync())
    await act(async () => {
      await result.current.syncNow()
    })

    expect(toastError).toHaveBeenCalled()
    expect(toastWarning).not.toHaveBeenCalled()
  })
})
