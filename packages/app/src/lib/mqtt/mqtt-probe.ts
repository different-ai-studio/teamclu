import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/utils'

export interface MqttProbeResult {
  ok: boolean
  latencyMs: number | null
  error: string | null
  connackCode: string | null
  brokerUrl: string
}

interface MqttProbeArgs {
  brokerUrl?: string
  brokerHost: string
  brokerPort: number
  username: string
  password: string
  teamId: string
  useTls: boolean
  timeoutMs?: number
}

/** One-shot broker probe via Rust rumqttc (Desktop only). */
export async function probeMqttBroker(args: MqttProbeArgs): Promise<MqttProbeResult | null> {
  if (!isTauri()) return null
  try {
    return await invoke<MqttProbeResult>('mqtt_probe', {
      brokerUrl: args.brokerUrl,
      brokerHost: args.brokerHost,
      brokerPort: args.brokerPort,
      username: args.username,
      password: args.password,
      teamId: args.teamId,
      useTls: args.useTls,
      timeoutMs: args.timeoutMs,
    })
  } catch (err) {
    return {
      ok: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
      connackCode: null,
      brokerUrl: args.brokerUrl ?? `${args.useTls ? 'mqtts' : 'mqtt'}://${args.brokerHost}:${args.brokerPort}`,
    }
  }
}
