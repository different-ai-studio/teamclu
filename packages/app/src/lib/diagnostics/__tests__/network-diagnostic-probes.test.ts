import { describe, expect, it } from 'vitest'
import { summarizeMqttNetworkEvents } from '@/lib/diagnostics/network-diagnostic-probes'

describe('summarizeMqttNetworkEvents', () => {
  it('counts recent disconnect and error events', () => {
    const now = Date.now()
    const ts = (offsetMs: number) => new Date(now - offsetMs).toISOString()
    const summary = summarizeMqttNetworkEvents([
      { ts: ts(60_000), scope: 'mqtt-bridge', event: 'error:post-connect', data: { message: 'auth failed' } },
      { ts: ts(120_000), scope: 'mqtt-bridge', event: 'state', data: { state: 'disconnected' } },
      { ts: ts(20 * 60_000), scope: 'mqtt-bridge', event: 'state', data: { state: 'disconnected' } },
    ])
    expect(summary.errorCount).toBe(1)
    expect(summary.disconnectCount).toBe(1)
    expect(summary.lastError).toBe('auth failed')
  })
})
