import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { useLocalDaemonTokenUsage } from '../use-local-daemon-token-usage'

const mocks = vi.hoisted(() => ({
  getCreditUsage: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ teams: { getCreditUsage: mocks.getCreditUsage } }),
}))

const ACTOR = 'b0f2c15f-0000-4000-8000-000000000001'

function report(byActor: Array<Record<string, unknown>>) {
  return {
    range: 'month',
    startUtc: '2026-09-01T00:00:00Z',
    endUtc: '2026-10-01T00:00:00Z',
    summary: { credits: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 0 },
    byModel: [],
    byActor,
  }
}

describe('useLocalDaemonTokenUsage', () => {
  beforeEach(() => {
    mocks.getCreditUsage.mockReset()
  })

  it('returns the actor row when it has usage', async () => {
    mocks.getCreditUsage.mockResolvedValue(
      report([
        { actorId: 'someone-else', displayName: 'Other', inputTokens: 999, cachedInputTokens: 0, outputTokens: 999, requests: 9, credits: 1 },
        { actorId: ACTOR, displayName: 'Mac-mini-3', inputTokens: 12_000, cachedInputTokens: 400, outputTokens: 3_400, requests: 42, credits: 5 },
      ]),
    )

    const { result } = renderHook(() => useLocalDaemonTokenUsage('team-1', ACTOR))

    await waitFor(() => {
      expect(result.current).toEqual({ inputTokens: 12_000, outputTokens: 3_400, requests: 42 })
    })
    expect(mocks.getCreditUsage).toHaveBeenCalledWith('team-1', { range: 'month' })
  })

  it('returns null when the gateway is unavailable — the majority of teams', async () => {
    mocks.getCreditUsage.mockRejectedValue(
      Object.assign(new Error('no gateway'), { code: 'ai_gateway_unavailable' }),
    )

    const { result } = renderHook(() => useLocalDaemonTokenUsage('team-1', ACTOR))

    await waitFor(() => expect(mocks.getCreditUsage).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('returns null when the actor has no row in the period', async () => {
    mocks.getCreditUsage.mockResolvedValue(
      report([{ actorId: 'someone-else', displayName: 'Other', inputTokens: 5, cachedInputTokens: 0, outputTokens: 5, requests: 1, credits: 0 }]),
    )

    const { result } = renderHook(() => useLocalDaemonTokenUsage('team-1', ACTOR))

    await waitFor(() => expect(mocks.getCreditUsage).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('returns null for a zero row rather than reporting 0 under a working agent', async () => {
    mocks.getCreditUsage.mockResolvedValue(
      report([{ actorId: ACTOR, displayName: 'Mac-mini-3', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 0, credits: 0 }]),
    )

    const { result } = renderHook(() => useLocalDaemonTokenUsage('team-1', ACTOR))

    await waitFor(() => expect(mocks.getCreditUsage).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('does not query without a team or an actor', () => {
    const { result } = renderHook(() => useLocalDaemonTokenUsage(null, ACTOR))
    expect(result.current).toBeNull()
    renderHook(() => useLocalDaemonTokenUsage('team-1', null))
    expect(mocks.getCreditUsage).not.toHaveBeenCalled()
  })
})
