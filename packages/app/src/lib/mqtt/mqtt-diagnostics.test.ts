import { describe, expect, it } from 'vitest'

function jwtWithExp(exp: number): string {
  const enc = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    sub: 'user-1',
    role: 'authenticated',
    aud: 'authenticated',
    iat: exp - 3600,
    exp,
  })}.sig`
}

describe('mqtt diagnostics', () => {
  it('reads the current auth session storage key', async () => {
    const { getMqttDiagSnapshot } = await import('@/lib/mqtt/mqtt-diagnostics')
    const exp = 1_783_050_348
    localStorage.setItem(
      'teamclu.session.v1',
      JSON.stringify({
        access_token: jwtWithExp(exp),
        refresh_token: 'refresh-token',
        expires_at: exp,
        user: { id: 'user-1', email: 'u@example.test' },
      }),
    )

    const snapshot = getMqttDiagSnapshot() as {
      localState?: {
        authSession?: {
          accessToken?: { exp?: number }
          refreshTokenPresent?: boolean
          user?: { id?: string }
        } | null
      }
    }

    expect(snapshot.localState?.authSession?.user?.id).toBe('user-1')
    expect(snapshot.localState?.authSession?.accessToken?.exp).toBe(exp)
    expect(snapshot.localState?.authSession?.refreshTokenPresent).toBe(true)
  })

  it('redacts sensitive values from local server config', async () => {
    const { getMqttDiagSnapshot } = await import('@/lib/mqtt/mqtt-diagnostics')
    localStorage.setItem(
      'teamclu.serverConfig',
      JSON.stringify({
        mqttHost: 'broker.example.test',
        mqttUsername: 'user-1',
        mqttPassword: 'secret-password',
        nested: {
          accessToken: 'secret-token',
        },
      }),
    )

    const snapshot = getMqttDiagSnapshot() as {
      localState?: {
        serverConfig?: {
          mqttHost?: string
          mqttUsername?: string
          mqttPassword?: string
          nested?: { accessToken?: string }
        } | null
      }
    }

    expect(snapshot.localState?.serverConfig?.mqttHost).toBe('broker.example.test')
    expect(snapshot.localState?.serverConfig?.mqttUsername).toBe('user-1')
    expect(snapshot.localState?.serverConfig?.mqttPassword).toBe('[redacted]')
    expect(snapshot.localState?.serverConfig?.nested?.accessToken).toBe('[redacted]')
  })
})
