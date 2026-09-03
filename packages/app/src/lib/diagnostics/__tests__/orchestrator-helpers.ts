import type { DiagnosticContext, TraceEvent } from '../types'

export function emptyCtx(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    online: true,
    daemon: {
      reachable: true,
      info: { configured_agent_types: ['opencode'], mqtt_connected: true, cloud_auth: { status: 'ok' } },
      liveConnected: true,
    },
    catalog: { status: 'models', backend: 'opencode', models: [] },
    teamLlm: null,
    outbox: [],
    traces: [],
    mqtt: {
      desktopConnected: true,
      desktopLastError: null,
      subscribedTopicCount: 2,
      daemonConnected: true,
      probe: {
        ok: true,
        latencyMs: 40,
        error: null,
        connackCode: 'Success',
        brokerUrl: 'wss://mqtt.example/mqtt',
      },
      eventSummary: {
        windowMinutes: 15,
        errorCount: 0,
        disconnectCount: 0,
        reconnectCount: 0,
        lastError: null,
      },
    },
    cloud: { reachable: true, bootstrapStatus: 200 },
    auth: { hasSession: true, tokenExpired: false, secondsUntilExpiry: 3600 },
    teamEnv: {
      teamIdPresent: true,
      teamLinkPath: '/tmp/link',
      linkExists: true,
      linkIsSymlink: true,
      linkTarget: '/tmp/target',
      targetAccessible: true,
      secretsDirExists: true,
      secretFileCount: 1,
      secretConfigured: true,
    },
    runtimeState: null,
    runtimeActivity: { active: true, lastTurnError: null },
    ...overrides,
  }
}

export function trace(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    traceId: 'm1',
    sessionId: 's1',
    stage: 'outbox.attempt',
    rawStage: 'outbox_sender.attempt.delivered',
    status: 'ok',
    startedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  }
}
