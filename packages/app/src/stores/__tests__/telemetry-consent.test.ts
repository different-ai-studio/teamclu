import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/build-config', () => ({
  appShortName: 'teamclu',
  appStoragePrefix: 'teamclu',
}))

vi.mock('@/lib/telemetry/scoring-engine', () => ({
  ScoringEngine: class {},
}))

vi.mock('@/lib/telemetry/report-builder', () => ({
  buildSessionReport: vi.fn(),
}))

vi.mock('@/stores/session-store', () => ({
  useSessionStore: { getState: vi.fn(() => ({ sessions: [] })) },
}))

vi.mock('@/lib/telemetry/supabase-feedback', () => ({
  insertFeedback: vi.fn(),
}))

vi.mock('@/lib/telemetry/supabase-session-report', () => ({
  insertSessionReport: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    directory: { resolveCurrentMemberActor: vi.fn() },
    telemetry: {
      deleteFeedback: vi.fn(),
      listFeedbacks: vi.fn(),
      insertFeedback: vi.fn(),
      insertSessionReport: vi.fn(),
    },
  }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: vi.fn(() => ({ team: null })) },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: vi.fn(() => ({ session: null })) },
}))

describe('telemetry consent store', () => {
  beforeEach(() => {
    vi.resetModules()
    mockInvoke.mockReset()
  })

  it('persists consent using the Tauri state parameter', async () => {
    const { useTelemetryStore } = await import('../telemetry')

    await useTelemetryStore.getState().setConsent('granted')

    expect(mockInvoke).toHaveBeenCalledWith('telemetry_set_consent', { state: 'granted' })
    expect(useTelemetryStore.getState().consent).toBe('granted')
  })
})
