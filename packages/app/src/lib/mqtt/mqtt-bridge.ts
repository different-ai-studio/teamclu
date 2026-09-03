import { isTauri } from '@/lib/utils'
import type * as TauriBridge from '@/lib/mqtt/mqtt-bridge-tauri'

export type { IncomingEnvelope } from '@/lib/mqtt/mqtt-bridge-tauri'

/**
 * The surface both platform bridges implement. Typed off the Tauri module so
 * the browser bridge is checked against the same shape at the `import()` below.
 */
type PlatformBridge = Pick<
  typeof TauriBridge,
  | 'mqttConnect'
  | 'mqttSubscribe'
  | 'mqttUnsubscribe'
  | 'mqttPublish'
  | 'mqttStatus'
  | 'listenForEnvelopes'
>

// Exactly one bridge is ever used per process: desktop talks to the Rust MQTT
// client over IPC, the browser build runs a worker-backed MQTT.js client. The
// two used to be static imports selected at call time, which put the ~360 KB
// browser bridge (and its worker adapter) on the desktop startup path for
// nothing. Loading the chosen half on first use keeps the other out of the
// preload set entirely; the promise is cached so the choice is made once.
let tauriBridge: Promise<PlatformBridge> | null = null
let browserBridge: Promise<PlatformBridge> | null = null

function impl(): Promise<PlatformBridge> {
  if (isTauri()) {
    tauriBridge ??= import('@/lib/mqtt/mqtt-bridge-tauri')
    return tauriBridge
  }
  browserBridge ??= import('@/lib/mqtt/mqtt-browser-bridge')
  return browserBridge
}

export const mqttConnect: typeof TauriBridge.mqttConnect = async (args) =>
  (await impl()).mqttConnect(args)
export const mqttSubscribe: typeof TauriBridge.mqttSubscribe = async (topic) =>
  (await impl()).mqttSubscribe(topic)
export const mqttUnsubscribe: typeof TauriBridge.mqttUnsubscribe = async (topic) =>
  (await impl()).mqttUnsubscribe(topic)
export const mqttPublish: typeof TauriBridge.mqttPublish = async (topic, bytes, retain) =>
  (await impl()).mqttPublish(topic, bytes, retain)
export const mqttStatus: typeof TauriBridge.mqttStatus = async () => (await impl()).mqttStatus()
export const listenForEnvelopes: typeof TauriBridge.listenForEnvelopes = async (handler) =>
  (await impl()).listenForEnvelopes(handler)
// Local daemon SSE fast-path status. Tauri-only: the browser bridge has no
// local daemon, so this resolves to a no-op unlisten there.
export const listenForDaemonLiveStatus: typeof TauriBridge.listenForDaemonLiveStatus = async (
  handler,
) => {
  if (!isTauri()) return () => {}
  const bridge = await import('@/lib/mqtt/mqtt-bridge-tauri')
  return bridge.listenForDaemonLiveStatus(handler)
}
