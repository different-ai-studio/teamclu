import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/utils', async (orig) => ({ ...(await orig<typeof import('@/lib/utils')>()), isTauri: () => false }))

describe('mqtt-bridge dispatch (non-tauri)', () => {
  beforeEach(() => vi.resetModules())
  it('routes mqttConnect to the browser bridge when not in tauri', async () => {
    const connectSpy = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@/lib/mqtt/mqtt-browser-bridge', () => ({
      mqttConnect: connectSpy,
      mqttSubscribe: vi.fn(), mqttUnsubscribe: vi.fn(), mqttPublish: vi.fn(),
      mqttStatus: vi.fn(), listenForEnvelopes: vi.fn(),
    }))
    const bridge = await import('@/lib/mqtt/mqtt-bridge')
    await bridge.mqttConnect({ brokerHost: 'h', brokerPort: 8083, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: false })
    expect(connectSpy).toHaveBeenCalledOnce()
  })
})
