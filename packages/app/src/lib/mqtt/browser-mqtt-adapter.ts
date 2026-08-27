import mqttPkg from 'mqtt'
import * as mqttNamespace from 'mqtt'
import { recordMqttDiag } from '../mqtt-diagnostics'

type MqttNamespace = { connect: (url: string, options?: unknown) => unknown }
const mqtt: MqttNamespace =
  mqttPkg && typeof (mqttPkg as MqttNamespace).connect === 'function'
    ? (mqttPkg as MqttNamespace)
    : (mqttNamespace as unknown as MqttNamespace)

export type BrowserMqttMessage = { topic: string; payload: Uint8Array }

export type BrowserMqttConnectOptions = {
  clientId?: string
  username?: string
  password?: string
  clean?: boolean
  protocolVersion?: 4 | 5
  properties?: {
    sessionExpiryInterval?: number
    [key: string]: unknown
  }
  keepalive?: number
  reconnectPeriod?: number
  connectTimeout?: number
  rejectUnauthorized?: boolean
}

export type BrowserMqttConnectArgs = { url: string; options?: BrowserMqttConnectOptions }

type MqttLikeClient = {
  on(e: string, h: (...a: never[]) => void): MqttLikeClient
  once(e: string, h: (...a: never[]) => void): MqttLikeClient
  removeListener(e: string, h: (...a: never[]) => void): MqttLikeClient
  subscribe(
    topic: string,
    opts: { qos: 0 | 1 | 2 },
    cb: (err?: Error | null, granted?: unknown[]) => void,
  ): void
  unsubscribe(topic: string, cb: (err?: Error | null) => void): void
  publish(topic: string, payload: Uint8Array | string, opts: { retain?: boolean }, cb: (err?: Error | null) => void): void
  end(force: boolean, opts: { properties?: { sessionExpiryInterval?: number } }, cb: () => void): void
}

export type BrowserMqttAdapter = {
  connect(args: BrowserMqttConnectArgs): Promise<void>
  subscribe(topic: string): Promise<void>
  unsubscribe(topic: string): Promise<void>
  publish(topic: string, payload: Uint8Array, retain?: boolean): Promise<void>
  disconnect(): Promise<void>
  onMessage(handler: (m: BrowserMqttMessage) => void): () => void
  onConnectionState(handler: (s: 'connecting' | 'connected' | 'disconnected') => void): () => void
  /** Post-connect errors (e.g. auth refusal during an automatic reconnect). */
  onError?(handler: (message: string) => void): () => void
}

export type BrowserMqttAdapterDeps = {
  createClient?: (url: string, options?: BrowserMqttConnectOptions) => MqttLikeClient
}

function defaultCreateClient(url: string, options?: BrowserMqttConnectOptions): MqttLikeClient {
  return mqtt.connect(url, options) as unknown as MqttLikeClient
}

function summarizeError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...Object.fromEntries(
        Object.entries(err as unknown as Record<string, unknown>).filter(([key]) => key !== 'stack'),
      ),
    }
  }
  return err
}

export function createBrowserMqttAdapter(deps: BrowserMqttAdapterDeps = {}): BrowserMqttAdapter {
  const createClient = deps.createClient ?? defaultCreateClient
  let client: MqttLikeClient | null = null
  const messageHandlers = new Set<(m: BrowserMqttMessage) => void>()
  const stateHandlers = new Set<(s: 'connecting' | 'connected' | 'disconnected') => void>()
  const errorHandlers = new Set<(message: string) => void>()

  function relayMessage(topic: string, payload: Uint8Array) {
    const m = { topic, payload: new Uint8Array(payload) }
    for (const h of messageHandlers) h(m)
  }
  function relayState(s: 'connecting' | 'connected' | 'disconnected') {
    for (const h of stateHandlers) h(s)
  }

  return {
    async connect(args) {
      if (client) throw new Error('MQTT client is already connected')
      recordMqttDiag('mqtt-adapter', 'connect:create-client', {
        url: args.url,
        options: args.options,
      })
      const next = createClient(args.url, args.options)
      client = next
      relayState('connecting')
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const reconnectEnabled = (args.options?.reconnectPeriod ?? 1000) > 0
        const onLaterError = (err: Error) => {
          // Post-connect errors (auth refusal on an automatic reconnect,
          // socket failures, …) must surface to subscribers so credential
          // recovery can kick in — mqtt.js keeps retrying silently otherwise.
          recordMqttDiag('mqtt-adapter', 'event:error-post-connect', { error: summarizeError(err) })
          const message = err instanceof Error ? err.message : String(err)
          for (const h of errorHandlers) h(message)
        }
        const onConnect = (packet?: unknown) => {
          recordMqttDiag('mqtt-adapter', 'event:connect', { packet })
          if (client !== next) return
          if (!settled) {
            settled = true
            next.removeListener('error', onError as never)
            next.on('error', onLaterError as never)
            next.on('message', relayMessage as never)
            next.on('close', onClosed as never)
            next.on('offline', onClosed as never)
            resolve()
          }
          relayState('connected')
        }
        const onError = (err: Error) => {
          recordMqttDiag('mqtt-adapter', 'event:error', { error: summarizeError(err) })
          next.removeListener('connect', onConnect as never)
          next.removeListener('error', onError as never)
          if (client === next) client = null
          relayState('disconnected')
          reject(err)
        }
        const onClosed = (...args: unknown[]) => {
          recordMqttDiag('mqtt-adapter', 'event:close-or-offline', { args })
          if (client !== next) return
          if (!reconnectEnabled) client = null
          relayState('disconnected')
        }
        const onReconnect = () => {
          recordMqttDiag('mqtt-adapter', 'event:reconnect')
          relayState('connecting')
        }
        const onEnd = () => {
          recordMqttDiag('mqtt-adapter', 'event:end')
        }
        next.on('connect', onConnect as never)
        next.once('error', onError as never)
        next.on('reconnect', onReconnect as never)
        next.on('end', onEnd as never)
      })
    },
    async subscribe(topic) {
      const c = client
      if (!c) throw new Error('MQTT client is not connected')
      await new Promise<void>((resolve, reject) => {
        recordMqttDiag('mqtt-adapter', 'subscribe:call', { topic })
        // QoS 1 so the broker queues messages for this session while the
        // client is offline (only effective with a persistent session).
        c.subscribe(topic, { qos: 1 }, (e, granted) => {
          if (e) {
            recordMqttDiag('mqtt-adapter', 'subscribe:callback-error', {
              topic,
              error: summarizeError(e),
              granted,
            })
            reject(e)
            return
          }
          recordMqttDiag('mqtt-adapter', 'subscribe:callback-ok', { topic, granted })
          resolve()
        })
      })
    },
    async unsubscribe(topic) {
      const c = client
      if (!c) throw new Error('MQTT client is not connected')
      await new Promise<void>((resolve, reject) => {
        recordMqttDiag('mqtt-adapter', 'unsubscribe:call', { topic })
        c.unsubscribe(topic, (e) => {
          if (e) {
            recordMqttDiag('mqtt-adapter', 'unsubscribe:callback-error', {
              topic,
              error: summarizeError(e),
            })
            reject(e)
            return
          }
          recordMqttDiag('mqtt-adapter', 'unsubscribe:callback-ok', { topic })
          resolve()
        })
      })
    },
    async publish(topic, payload, retain = false) {
      const c = client
      if (!c) throw new Error('MQTT client is not connected')
      await new Promise<void>((resolve, reject) =>
        c.publish(topic, payload, { retain }, (e) => {
          if (e) {
            recordMqttDiag('mqtt-adapter', 'publish:callback-error', {
              topic,
              retain,
              error: summarizeError(e),
            })
            reject(e)
            return
          }
          recordMqttDiag('mqtt-adapter', 'publish:callback-ok', { topic, retain })
          resolve()
        }),
      )
    },
    async disconnect() {
      const c = client
      client = null
      recordMqttDiag('mqtt-adapter', 'disconnect')
      relayState('disconnected')
      if (!c) return
      await new Promise<void>((resolve) => c.end(false, { properties: { sessionExpiryInterval: 0 } }, resolve))
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    },
    onConnectionState(handler) {
      stateHandlers.add(handler)
      return () => stateHandlers.delete(handler)
    },
    onError(handler) {
      errorHandlers.add(handler)
      return () => errorHandlers.delete(handler)
    },
  }
}
