import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/build-config', () => ({
  buildConfig: { app: { palette: 'default' } },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
}))

vi.mock('@/lib/version', () => ({
  fetchAppVersion: vi.fn(async () => '1.0.0-test'),
}))

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttStatus: vi.fn(async () => ({ connected: true, subscribedTopics: ['t/a/in'] })),
}))

vi.mock('@/lib/mqtt-diagnostics', () => ({
  getMqttDiagSnapshot: vi.fn(() => ({
    generatedAt: '2026-01-01T00:00:00.000Z',
    events: [{ ts: '2026-01-01T00:00:00.000Z', scope: 'mqtt', event: 'connect' }],
  })),
}))

vi.mock('@/lib/auth/session-store', () => ({
  getSession: vi.fn(() => ({
    access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig',
    refresh_token: 'refresh',
    expires_at: 4102444800,
    user: { id: 'user-1', email: 'test@example.com' },
  })),
}))

vi.mock('@/lib/startup-perf', () => ({
  getStartupTimeline: vi.fn(() => [{ label: 'main:start', ms: 0 }]),
}))

vi.mock('@/lib/live-dedup-stats', () => ({
  getDaemonLiveConnected: vi.fn(() => true),
}))

vi.mock('@/lib/daemon-local-client', () => ({
  probeDaemonHttp: vi.fn(async () => ({ ok: false, reason: 'not_tauri' })),
}))

vi.mock('@/stores/mqtt-reconnect', () => ({
  useMqttReconnectStore: {
    getState: vi.fn(() => ({
      connected: true,
      lastError: null,
      nonce: 1,
    })),
  },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: {
    getState: vi.fn(() => ({
      activeSessionId: 'sess-1',
      currentSessionId: 'sess-1',
    })),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: vi.fn(() => ({
      team: { id: 'team-1', name: 'Team One', slug: 'team-one' },
    })),
  },
}))

import { getRuntimeStateSnapshot } from '@/lib/runtime-state-snapshot'

describe('runtime-state-snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a redacted runtime snapshot without raw tokens', async () => {
    const snapshot = await getRuntimeStateSnapshot()
    expect(snapshot.environment.version).toBe('1.0.0-test')
    expect(snapshot.team.id).toBe('team-1')
    expect(snapshot.auth?.refreshTokenPresent).toBe(true)
    expect(snapshot.auth?.accessToken).toMatchObject({ kind: 'jwt', sub: 'user' })
    expect(JSON.stringify(snapshot)).not.toContain('eyJhbGci')
    expect(snapshot.mqtt.recentEvents).toHaveLength(1)
    expect(snapshot.mqtt.daemonLiveConnected).toBe(true)
  })
})
