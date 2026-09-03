import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/session-store', () => ({
  getFreshAccessToken: vi.fn(),
}))

vi.mock('@/lib/mqtt/mqtt-bridge', () => ({
  mqttConnect: vi.fn(),
}))

describe('connectMqttWithFreshAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function jwtWithExp(exp: number): string {
    const enc = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ exp })}.sig`
  }

  it('refreshes the access token before opening the MQTT connection', async () => {
    const { getFreshAccessToken } = await import('@/lib/auth/session-store')
    const { mqttConnect } = await import('@/lib/mqtt/mqtt-bridge')
    const { connectMqttWithFreshAuth } = await import('@/lib/mqtt/mqtt-connect-with-fresh-auth')

    vi.mocked(getFreshAccessToken).mockResolvedValue('fresh-token')
    vi.mocked(mqttConnect).mockResolvedValue(undefined)

    await connectMqttWithFreshAuth({
      brokerHost: 'mqtt.example.test',
      brokerPort: 1883,
      username: 'member-actor-1',
      clientId: 'teamclu-member-random',
      teamId: 'team-1',
      useTls: false,
    })

    expect(getFreshAccessToken).toHaveBeenCalledOnce()
    expect(mqttConnect).toHaveBeenCalledWith({
      brokerHost: 'mqtt.example.test',
      brokerPort: 1883,
      username: 'member-actor-1',
      password: 'fresh-token',
      clientId: 'teamclu-member-random',
      teamId: 'team-1',
      useTls: false,
    })
  })

  it('does not attempt MQTT auth with an expired access token', async () => {
    const { getFreshAccessToken } = await import('@/lib/auth/session-store')
    const { mqttConnect } = await import('@/lib/mqtt/mqtt-bridge')
    const { connectMqttWithFreshAuth } = await import('@/lib/mqtt/mqtt-connect-with-fresh-auth')

    vi.mocked(getFreshAccessToken).mockResolvedValue(jwtWithExp(Math.floor(Date.now() / 1000) - 1))
    vi.mocked(mqttConnect).mockResolvedValue(undefined)

    await expect(
      connectMqttWithFreshAuth({
        brokerHost: 'mqtt.example.test',
        brokerPort: 1883,
        username: 'member-actor-1',
        clientId: 'teamclu-member-random',
        teamId: 'team-1',
        useTls: false,
      }),
    ).rejects.toThrow('MQTT access token is expired')

    expect(mqttConnect).not.toHaveBeenCalled()
  })
})
