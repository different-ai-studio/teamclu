import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/build-config', () => ({
  buildConfig: { app: { palette: 'default' } },
  localAgent: 'opencode',
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@/lib/version', () => ({
  fetchAppVersion: vi.fn(async () => '1.0.0-test'),
}))

const getEffectiveServerConfigSyncMock = vi.fn(() => ({
  cloudApiUrl: 'https://api.example.com',
  mqttUrl: 'wss://mqtt.example/mqtt',
  mqttHost: 'mqtt.example',
  mqttPort: 443,
  mqttUseTls: true,
  mqttUsername: 'user',
  mqttPassword: 'pass',
}))

vi.mock('@/lib/server-config', () => ({
  getEffectiveServerConfigSync: () => getEffectiveServerConfigSyncMock(),
}))

vi.mock('@/lib/mqtt-bridge', () => ({
  mqttStatus: vi.fn(async () => ({ connected: true, subscribedTopics: ['amux/t1/a1/in'] })),
}))

vi.mock('@/lib/mqtt-probe', () => ({
  probeMqttBroker: vi.fn(async () => ({
    ok: true,
    latencyMs: 120,
    error: null,
    connackCode: 'Success',
    brokerUrl: 'wss://mqtt.example/mqtt',
  })),
}))

vi.mock('@/lib/live-dedup-stats', () => ({
  getDaemonLiveConnected: vi.fn(() => false),
}))

vi.mock('@/lib/current-actor', () => ({
  resolveCurrentMemberActorId: vi.fn(async () => 'actor-1'),
}))

vi.mock('@/lib/auth/session-store', () => ({
  getSession: vi.fn(() => ({ access_token: 'test-token', user: { id: 'user-1' } })),
}))

vi.mock('@/lib/mqtt-diagnostics', () => ({
  getMqttDiagSnapshot: vi.fn(() => ({
    generatedAt: '2026-01-01T00:00:00.000Z',
    localState: {
      authSession: {
        accessToken: { expired: false, secondsUntilExpiry: 3600 },
      },
    },
    events: [],
  })),
}))

vi.mock('@/lib/startup-perf', () => ({
  getStartupTimeline: vi.fn(() => [{ name: 'app:ready', t: 120 }]),
}))

vi.mock('@/lib/console-capture', () => ({
  getConsoleEntries: vi.fn(() => [{ ts: 1, level: 'info', message: 'test', args: [] }]),
}))

vi.mock('@/lib/runtime-state-snapshot', () => ({
  getRuntimeStateSnapshot: vi.fn(async () => ({
    generatedAt: '2026-01-01T00:00:00.000Z',
    environment: { version: '1.0.0-test', buildFlavor: 'default', platform: 'MacIntel', tauri: true, userAgent: null, visibilityState: 'visible' },
    mqtt: { bridge: null, reconnect: { connected: true, lastError: null, nonce: 0 }, recentEvents: [], daemonLiveConnected: false },
    auth: null,
    session: { activeSessionId: null, currentSessionId: null },
    streaming: { streamingMessageId: null, streamingContentLength: 0, activeChildSessions: [] },
    team: { id: 'team-1', name: null },
    daemon: null,
    startupTimeline: [],
  })),
}))

vi.mock('@/lib/daemon-local-client', () => ({
  probeDaemonHttp: vi.fn(async () => ({ ok: true, baseUrl: 'http://127.0.0.1:8765' })),
  getDaemonModelCatalog: vi.fn(async () => ({
    automation_default_backend: 'opencode',
    backends: [
      {
        backend: 'opencode',
        label: 'OpenCode',
        models: [{ ref: 'opencode/big-pickle', display_name: 'Big Pickle' }],
      },
    ],
  })),
  encodeWorkspaceId: (path: string) => path,
}))

vi.mock('@/stores/mqtt-reconnect', () => ({
  useMqttReconnectStore: {
    getState: () => ({
      connected: true,
      lastError: null,
      ensureWired: vi.fn(),
    }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-1' } }),
  },
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/tmp/workspace' }),
  },
}))

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

describe('collectDiagnosticReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getEffectiveServerConfigSyncMock.mockReturnValue({
      cloudApiUrl: 'https://api.example.com',
      mqttUrl: 'wss://mqtt.example/mqtt',
      mqttHost: 'mqtt.example',
      mqttPort: 443,
      mqttUseTls: true,
      mqttUsername: 'user',
      mqttPassword: 'pass',
    })
    invokeMock.mockResolvedValue({
      doctor: { opencode: { satisfied: true, version: '1.2.3' } },
      requirements: [
        { id: 'git', title: 'Git', optional: false, present: true, version: '2.40' },
      ],
      teamEnv: {
        teamIdPresent: true,
        teamLinkPath: '/tmp/workspace/teamclu-team',
        linkExists: true,
        linkIsSymlink: true,
        linkTarget: '/tmp/teams/team-1',
        targetAccessible: true,
        secretsDirExists: true,
        secretFileCount: 1,
        secretConfigured: true,
      },
      logTails: { amuxd: 'line1', acpStream: null },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/healthz')) {
          return { ok: false, status: 503 }
        }
        if (url.endsWith('/v1/config/public')) {
          return { ok: true, status: 200, json: async () => ({}) }
        }
        if (url.endsWith('/v1/config/bootstrap')) {
          return { ok: true, status: 200, json: async () => ({ mqtt: { url: 'wss://mqtt.example/mqtt' } }) }
        }
        if (url.endsWith('/v1/info')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              mqtt_connected: true,
              cloud_auth: { status: 'ok' },
              agent_types_advertise: { advertised: true, lastError: null },
            }),
          }
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    vi.stubGlobal('navigator', { onLine: true, platform: 'MacIntel' } as Navigator)
  })

  it('builds a v2 report with passing checks when dependencies are healthy', async () => {
    const { collectDiagnosticReport } = await import('@/lib/diagnostic-report')
    const report = await collectDiagnosticReport()

    expect(report.schemaVersion).toBe(2)
    expect(Array.isArray(report.findings)).toBe(true)
    expect(Array.isArray(report.causeCodes)).toBe(true)
    expect(Array.isArray(report.traces)).toBe(true)
    expect(report.findings.some((f) => f.code === 'model.catalog_ok')).toBe(true)
    expect(report.app.version).toBe('1.0.0-test')
    expect(report.summary.fail).toBe(0)
    expect(report.checks.some((c) => c.id === 'cloud_api' && c.status === 'ok')).toBe(true)
    expect(report.checks.some((c) => c.id === 'cloud_api_bootstrap' && c.status === 'ok')).toBe(true)
    expect(report.checks.some((c) => c.id === 'mqtt_config' && c.status === 'ok')).toBe(true)
    expect(report.checks.some((c) => c.id === 'mqtt_bridge' && c.status === 'ok')).toBe(true)
    expect(report.checks.some((c) => c.id === 'mqtt' && c.status === 'ok')).toBe(true)
    expect(report.checks.some((c) => c.id === 'team_env' && c.status === 'ok')).toBe(true)
    expect(report.checks.some((c) => c.id === 'mqtt_probe' && c.status === 'ok')).toBe(true)
    expect(report.details.network.mqttProbe?.ok).toBe(true)
    expect(report.details.network.daemonLiveConnected).toBe(false)
    expect(report.details.runtimeState?.team.id).toBe('team-1')
    expect(invokeMock).toHaveBeenCalledWith('collect_diagnostic_bundle', expect.any(Object))
  })

  it('marks cloud api ok when public works even if healthz fails', async () => {
    const { collectDiagnosticReport } = await import('@/lib/diagnostic-report')
    const report = await collectDiagnosticReport()
    const cloud = report.checks.find((c) => c.id === 'cloud_api')
    expect(cloud?.status).toBe('ok')
    expect(cloud?.message).toContain('healthz 不可达')
  })

  it('marks cloud api as fail when all endpoints unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const { collectDiagnosticReport } = await import('@/lib/diagnostic-report')
    const report = await collectDiagnosticReport()
    const cloud = report.checks.find((c) => c.id === 'cloud_api')
    expect(cloud?.status).toBe('fail')
    expect(report.summary.fail).toBeGreaterThan(0)
  })

  it('marks mqtt config ok with JWT auth when bootstrap credentials are absent', async () => {
    getEffectiveServerConfigSyncMock.mockReturnValue({
      cloudApiUrl: 'https://api.example.com',
      mqttUrl: 'wss://copilot.accounting.i.test.shopee.io/mqtt',
      mqttHost: 'copilot.accounting.i.test.shopee.io',
      mqttPort: 443,
      mqttUseTls: true,
      mqttUsername: undefined,
      mqttPassword: undefined,
    })

    const { collectDiagnosticReport } = await import('@/lib/diagnostic-report')
    const report = await collectDiagnosticReport()
    const mqttConfig = report.checks.find((c) => c.id === 'mqtt_config')
    expect(mqttConfig?.status).toBe('ok')
    expect(mqttConfig?.message).toContain('JWT')
  })

  it('tags token_invalid daemon probe with a reset trigger', async () => {
    const { probeDaemonHttp } = await import('@/lib/daemon-local-client')
    vi.mocked(probeDaemonHttp).mockResolvedValueOnce({
      ok: false,
      reason: 'token_invalid',
    })

    const { collectDiagnosticReport } = await import('@/lib/diagnostic-report')
    const report = await collectDiagnosticReport()
    const daemonHttp = report.checks.find((c) => c.id === 'daemon_http')

    expect(daemonHttp?.resetTrigger).toBe('daemon_http_token_invalid')
  })

  it('names the zip after the first failing cause code', async () => {
    const { diagnosticZipFilename } = await import('@/lib/diagnostic-report')
    const stamp = new Date(2026, 8, 3, 14, 14, 0)
    expect(
      diagnosticZipFilename(
        { causeCodes: ['model.backend_probe_failed', 'send.mqtt_publish_failed'] },
        stamp,
      ),
    ).toBe('teamclu-diag-20260903-1414-model-backend_probe_failed.zip')
    expect(diagnosticZipFilename({ causeCodes: [] }, stamp)).toBe('teamclu-diag-20260903-1414.zip')
  })
})
