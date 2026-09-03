import { describe, expect, it } from 'vitest'
import { diagnose } from '../orchestrator'
import { emptyCtx } from './orchestrator-helpers'

describe('diagnose realtime flow', () => {
  it('classifies broker auth failure separately from network failure', () => {
    const auth = diagnose(
      emptyCtx({
        mqtt: {
          ...emptyCtx().mqtt,
          probe: {
            ok: false,
            latencyMs: null,
            error: 'BadUserNamePassword',
            connackCode: 'BadUserNamePassword',
            brokerUrl: 'wss://mqtt.example/mqtt',
          },
        },
      }),
    )
    expect(auth.find((f) => f.code === 'realtime.mqtt_auth_failed')?.status).toBe('fail')

    const network = diagnose(
      emptyCtx({
        mqtt: {
          ...emptyCtx().mqtt,
          desktopConnected: false,
          probe: {
            ok: false,
            latencyMs: null,
            error: 'connection refused',
            connackCode: null,
            brokerUrl: 'wss://mqtt.example/mqtt',
          },
        },
      }),
    )
    expect(network.find((f) => f.code === 'realtime.mqtt_network_failed')?.status).toBe('fail')
    expect(network.some((f) => f.code === 'realtime.mqtt_auth_failed')).toBe(false)
  })

  it('upgrades live-path split into sse_fallback and flags desktop/daemon mismatch', () => {
    const fallback = diagnose(
      emptyCtx({
        daemon: {
          reachable: true,
          info: { mqtt_connected: false },
          liveConnected: true,
        },
        mqtt: {
          ...emptyCtx().mqtt,
          desktopConnected: false,
          daemonConnected: false,
          probe: {
            ok: false,
            latencyMs: null,
            error: 'timeout',
            connackCode: null,
            brokerUrl: 'wss://mqtt.example/mqtt',
          },
        },
      }),
    )
    expect(fallback.some((f) => f.code === 'realtime.sse_fallback')).toBe(true)

    const desktopOnly = diagnose(
      emptyCtx({
        daemon: {
          reachable: true,
          info: { mqtt_connected: false },
          liveConnected: false,
        },
        mqtt: {
          ...emptyCtx().mqtt,
          desktopConnected: true,
          daemonConnected: false,
          probe: { ok: true, latencyMs: 10, error: null, connackCode: 'Success', brokerUrl: 'wss://x' },
        },
      }),
    )
    expect(desktopOnly.some((f) => f.code === 'realtime.mqtt_desktop_only')).toBe(true)
  })
})

describe('diagnose auth_sync flow', () => {
  it('reports invalid session and broken team link', () => {
    const findings = diagnose(
      emptyCtx({
        auth: { hasSession: false, tokenExpired: false, secondsUntilExpiry: null },
        teamEnv: {
          teamIdPresent: true,
          teamLinkPath: '/tmp/link',
          linkExists: false,
          linkIsSymlink: false,
          linkTarget: null,
          targetAccessible: false,
          secretsDirExists: false,
          secretFileCount: 0,
          secretConfigured: false,
        },
      }),
    )
    expect(findings.some((f) => f.code === 'auth.session_invalid')).toBe(true)
    expect(findings.some((f) => f.code === 'sync.team_link_broken')).toBe(true)
  })
})
