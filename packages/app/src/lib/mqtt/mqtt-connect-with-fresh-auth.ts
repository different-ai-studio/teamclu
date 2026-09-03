import { getFreshAccessToken } from '@/lib/auth/session-store'
import { mqttConnect } from '@/lib/mqtt/mqtt-bridge'

type MqttConnectWithFreshAuthArgs = {
  brokerUrl?: string
  brokerHost: string
  brokerPort: number
  username: string
  clientId: string
  teamId: string
  useTls: boolean
  configuredPassword?: string
}

function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = JSON.parse(atob(padded)) as { exp?: unknown }
    return typeof decoded.exp === 'number' ? decoded.exp : null
  } catch {
    return null
  }
}

export async function connectMqttWithFreshAuth(args: MqttConnectWithFreshAuthArgs): Promise<void> {
  const password = args.configuredPassword ?? await getFreshAccessToken()
  if (!args.configuredPassword) {
    const exp = decodeJwtExp(password)
    if (exp !== null && exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('MQTT access token is expired')
    }
  }
  await mqttConnect({
    brokerUrl: args.brokerUrl,
    brokerHost: args.brokerHost,
    brokerPort: args.brokerPort,
    username: args.username,
    password,
    clientId: args.clientId,
    teamId: args.teamId,
    useTls: args.useTls,
  })
}
