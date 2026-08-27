import type { BrowserMqttAdapter } from './mqtt/browser-mqtt-adapter'
import { createDefaultMqttAdapter } from './mqtt/worker-mqtt-adapter'
import { describeJwt, recordMqttDiag } from './mqtt-diagnostics'

export interface IncomingEnvelope {
  topic: string
  bytes: Uint8Array
}

let adapter: BrowserMqttAdapter | null = null
let connected = false
let activeConnectionKey: string | null = null
let connectingKey: string | null = null
let connectingPromise: Promise<void> | null = null
let connectGeneration = 0
const subscribedTopics = new Set<string>()

// Module-level sets of external state subscribers
const stateSubscribers = new Set<(state: 'connecting' | 'connected' | 'disconnected') => void>()
const errorSubscribers = new Set<(message: string) => void>()

function shortIdPart(value: string, fallback: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || fallback
}

function createBrowserInstanceId(): string {
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return shortIdPart(generated, 'instance')
}

const browserClientInstanceId = createBrowserInstanceId()

function stableBrowserClientId(username: string, teamId: string): string {
  const actorPart = shortIdPart(username.trim(), 'browser')
  const teamPart = shortIdPart(teamId.trim(), 'team')
  return `teamclu-${actorPart}-${teamPart}-browser-${browserClientInstanceId}`
}

function connectionKey(input: {
  url: string
  clientId: string
  username: string
  password: string
}): string {
  return JSON.stringify(input)
}

function ensureAdapter(): BrowserMqttAdapter {
  if (!adapter) {
    recordMqttDiag('mqtt-bridge', 'adapter:create')
    adapter = createDefaultMqttAdapter()
    adapter.onConnectionState((state) => {
      connected = state === 'connected'
      recordMqttDiag('mqtt-bridge', 'state', { state, subscribedTopics: Array.from(subscribedTopics) })
      for (const h of stateSubscribers) h(state)
    })
    // Post-connect errors (e.g. JWT expired when an automatic reconnect
    // attempt is refused) — feed the same subscribers as connect() failures
    // so credential recovery in the mqtt-reconnect store can trigger.
    adapter.onError?.((message) => {
      recordMqttDiag('mqtt-bridge', 'error:post-connect', { message })
      for (const h of errorSubscribers) h(message)
    })
  }
  return adapter
}

// 测试注入点：替换 adapter、清空状态
export function __resetBrowserMqttForTest(opts?: { adapter?: BrowserMqttAdapter }): void {
  const injected = opts?.adapter ?? null
  adapter = injected
  connected = false
  activeConnectionKey = null
  connectingKey = null
  connectingPromise = null
  connectGeneration = 0
  subscribedTopics.clear()
  stateSubscribers.clear()
  errorSubscribers.clear()
  if (injected) {
    injected.onConnectionState((state) => {
      connected = state === 'connected'
      for (const h of stateSubscribers) h(state)
    })
    injected.onError?.((message) => {
      for (const h of errorSubscribers) h(message)
    })
  }
}

/**
 * Subscribe to browser MQTT connection state changes.
 * Lazily ensures the adapter exists so subscription works before connect().
 * Returns an unsubscribe function.
 */
export function subscribeBrowserMqttState(
  handler: (state: 'connecting' | 'connected' | 'disconnected') => void,
): () => void {
  // Ensure adapter exists so onConnectionState wiring is set up
  ensureAdapter()
  stateSubscribers.add(handler)
  return () => stateSubscribers.delete(handler)
}

/**
 * Subscribe to browser MQTT connect errors.
 * Returns an unsubscribe function.
 */
export function subscribeBrowserMqttError(handler: (message: string) => void): () => void {
  errorSubscribers.add(handler)
  return () => errorSubscribers.delete(handler)
}

export async function mqttConnect(args: {
  brokerUrl?: string
  brokerHost: string
  brokerPort: number
  username: string
  password: string
  clientId: string
  teamId: string
  useTls: boolean
}): Promise<void> {
  const scheme = args.useTls ? 'wss' : 'ws'
  const url = args.brokerUrl ?? `${scheme}://${args.brokerHost}:${args.brokerPort}/mqtt`
  const clientId = stableBrowserClientId(args.username, args.teamId)
  const key = connectionKey({
    url,
    clientId,
    username: args.username,
    password: args.password,
  })
  if (connected && activeConnectionKey === key) return
  if (connectingPromise && connectingKey === key) {
    await connectingPromise
    return
  }

  const currentAdapter = ensureAdapter()
  if (connected || activeConnectionKey || connectingPromise) {
    recordMqttDiag('mqtt-bridge', 'connect:replace-client', {
      wasConnected: connected,
      hasActiveConnection: Boolean(activeConnectionKey),
      hasConnectingPromise: Boolean(connectingPromise),
    })
    try {
      await currentAdapter.disconnect()
    } catch (error) {
      recordMqttDiag('mqtt-bridge', 'connect:replace-disconnect-error', {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      })
    }
    connected = false
    activeConnectionKey = null
    connectingKey = null
    connectingPromise = null
    connectGeneration++
  }
  recordMqttDiag('mqtt-bridge', 'connect:begin', {
    url,
    brokerHost: args.brokerHost,
    brokerPort: args.brokerPort,
    useTls: args.useTls,
    clientId,
    requestedClientId: args.clientId,
    username: args.username,
    teamId: args.teamId,
    password: describeJwt(args.password),
  })
  connectingKey = key
  const generation = ++connectGeneration
  const connectPromise = currentAdapter.connect({
    url,
    options: {
      clientId,
      username: args.username,
      password: args.password,
      // Persistent session within this page lifetime: the clientId is stable
      // per page load (random suffix, never shared across tabs), so on an
      // automatic reconnect the broker resumes subscriptions and replays
      // QoS1 messages queued during the offline window. Intentional
      // disconnect() still ends with sessionExpiryInterval:0 to purge.
      clean: false,
      protocolVersion: 5,
      properties: { sessionExpiryInterval: 300 },
      keepalive: 30,
      // mqtt.js auto-reconnect as the transport-level safety net; the
      // mqtt-reconnect store stays on top for credential refresh.
      reconnectPeriod: 3000,
      connectTimeout: 15000,
    },
  })
  connectingPromise = connectPromise
  try {
    await connectPromise
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordMqttDiag('mqtt-bridge', 'connect:error', { message })
    for (const h of errorSubscribers) h(message)
    throw err
  } finally {
    if (connectingPromise === connectPromise && connectGeneration === generation) {
      connectingPromise = null
      connectingKey = null
    }
  }
  if (connectGeneration !== generation) return
  connected = true
  activeConnectionKey = key
  recordMqttDiag('mqtt-bridge', 'connect:ok', {
    clientId,
    requestedClientId: args.clientId,
    username: args.username,
    teamId: args.teamId,
  })
}

export async function mqttSubscribe(topic: string): Promise<void> {
  recordMqttDiag('mqtt-bridge', 'subscribe:begin', { topic })
  try {
    await ensureAdapter().subscribe(topic)
    subscribedTopics.add(topic)
    recordMqttDiag('mqtt-bridge', 'subscribe:ok', { topic, subscribedTopics: Array.from(subscribedTopics) })
  } catch (error) {
    recordMqttDiag('mqtt-bridge', 'subscribe:error', {
      topic,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    })
    throw error
  }
}

export async function mqttUnsubscribe(topic: string): Promise<void> {
  subscribedTopics.delete(topic)
  if (!connected) {
    recordMqttDiag('mqtt-bridge', 'unsubscribe:local-only-not-connected', { topic })
    return
  }
  recordMqttDiag('mqtt-bridge', 'unsubscribe:begin', { topic })
  try {
    await ensureAdapter().unsubscribe(topic)
    recordMqttDiag('mqtt-bridge', 'unsubscribe:ok', { topic })
  } catch (error) {
    recordMqttDiag('mqtt-bridge', 'unsubscribe:error', {
      topic,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    })
    throw error
  }
}

export async function mqttPublish(topic: string, bytes: Uint8Array, retain = false): Promise<void> {
  recordMqttDiag('mqtt-bridge', 'publish:begin', { topic, bytes: bytes.byteLength, retain })
  try {
    await ensureAdapter().publish(topic, bytes, retain)
    recordMqttDiag('mqtt-bridge', 'publish:ok', { topic, bytes: bytes.byteLength, retain })
  } catch (error) {
    recordMqttDiag('mqtt-bridge', 'publish:error', {
      topic,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    })
    throw error
  }
}

export async function mqttStatus(): Promise<{ connected: boolean; subscribedTopics: string[] }> {
  const status = { connected, subscribedTopics: Array.from(subscribedTopics) }
  recordMqttDiag('mqtt-bridge', 'status', status)
  return status
}

export async function listenForEnvelopes(
  handler: (env: IncomingEnvelope) => void,
): Promise<() => void> {
  recordMqttDiag('mqtt-bridge', 'listen:attach')
  const off = ensureAdapter().onMessage((m) => {
    recordMqttDiag('mqtt-bridge', 'message', { topic: m.topic, bytes: m.payload.byteLength })
    handler({ topic: m.topic, bytes: m.payload })
  })
  return () => {
    recordMqttDiag('mqtt-bridge', 'listen:detach')
    off()
  }
}
