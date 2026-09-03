import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

describe('probeMqttBroker', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('invokes mqtt_probe with broker args', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      latencyMs: 88,
      error: null,
      connackCode: 'Success',
      brokerUrl: 'wss://mqtt.example/mqtt',
    })
    const { probeMqttBroker } = await import('@/lib/mqtt/mqtt-probe')
    const result = await probeMqttBroker({
      brokerUrl: 'wss://mqtt.example/mqtt',
      brokerHost: 'mqtt.example.com',
      brokerPort: 443,
      username: 'actor-1',
      password: 'jwt-token',
      teamId: 'team-1',
      useTls: true,
      timeoutMs: 5000,
    })
    expect(invokeMock).toHaveBeenCalledWith('mqtt_probe', expect.objectContaining({
      brokerHost: 'mqtt.example.com',
      username: 'actor-1',
      teamId: 'team-1',
      timeoutMs: 5000,
    }))
    expect(result?.ok).toBe(true)
  })

  it('returns structured failure when invoke throws', async () => {
    invokeMock.mockRejectedValue(new Error('ipc unavailable'))
    const { probeMqttBroker } = await import('@/lib/mqtt/mqtt-probe')
    const result = await probeMqttBroker({
      brokerHost: 'mqtt.example.com',
      brokerPort: 443,
      username: 'actor-1',
      password: 'jwt-token',
      teamId: 'team-1',
      useTls: true,
    })
    expect(result?.ok).toBe(false)
    expect(result?.error).toContain('ipc unavailable')
  })
})
