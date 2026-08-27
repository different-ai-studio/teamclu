// Page-side client for the MQTT connection worker. Implements the same
// BrowserMqttAdapter interface as the inline adapter, but forwards every call
// to mqtt-connection.worker.ts over a small postMessage RPC so mqtt.js (and
// its keepalive timers) run outside the throttled page context.
import {
  createBrowserMqttAdapter,
  type BrowserMqttAdapter,
  type BrowserMqttMessage,
} from './browser-mqtt-adapter'
import type { MqttWorkerEvent, MqttWorkerRequest } from './mqtt-connection.worker'
import { recordMqttDiag } from '../mqtt-diagnostics'

export type MqttWorkerLike = {
  postMessage(data: MqttWorkerRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', handler: (e: MessageEvent<MqttWorkerEvent>) => void): void
  addEventListener(type: 'error', handler: (e: ErrorEvent) => void): void
  terminate(): void
}

export function createWorkerMqttAdapter(createWorker: () => MqttWorkerLike): BrowserMqttAdapter {
  let worker: MqttWorkerLike | null = null
  let nextId = 1
  const pending = new Map<number, { resolve: () => void; reject: (err: Error) => void }>()
  const messageHandlers = new Set<(m: BrowserMqttMessage) => void>()
  const stateHandlers = new Set<(s: 'connecting' | 'connected' | 'disconnected') => void>()
  const errorHandlers = new Set<(message: string) => void>()

  function onWorkerEvent(e: MessageEvent<MqttWorkerEvent>) {
    const ev = e.data
    switch (ev.kind) {
      case 'result': {
        const entry = pending.get(ev.id)
        if (!entry) return
        pending.delete(ev.id)
        if (ev.ok) entry.resolve()
        else entry.reject(new Error(ev.error))
        break
      }
      case 'message': {
        const m = { topic: ev.topic, payload: ev.payload }
        for (const h of messageHandlers) h(m)
        break
      }
      case 'state':
        for (const h of stateHandlers) h(ev.state)
        break
      case 'error':
        for (const h of errorHandlers) h(ev.message)
        break
    }
  }

  function onWorkerError(e: ErrorEvent) {
    // Worker script failure (load/runtime crash): fail everything in flight
    // and surface a disconnect so the reconnect store can react.
    recordMqttDiag('mqtt-worker-adapter', 'worker:error', { message: e.message })
    const err = new Error(`mqtt worker error: ${e.message || 'unknown'}`)
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
    for (const h of errorHandlers) h(err.message)
    for (const h of stateHandlers) h('disconnected')
  }

  function ensureWorker(): MqttWorkerLike {
    if (!worker) {
      recordMqttDiag('mqtt-worker-adapter', 'worker:create')
      worker = createWorker()
      worker.addEventListener('message', onWorkerEvent)
      worker.addEventListener('error', onWorkerError)
    }
    return worker
  }

  // Distributive omit: `Omit<Union, 'id'>` would collapse the union.
  type MqttWorkerCall = MqttWorkerRequest extends infer R
    ? R extends MqttWorkerRequest
      ? Omit<R, 'id'>
      : never
    : never

  function call(req: MqttWorkerCall, transfer?: Transferable[]): Promise<void> {
    const w = ensureWorker()
    const id = nextId++
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      w.postMessage({ ...req, id } as MqttWorkerRequest, transfer)
    })
  }

  return {
    connect: (args) => call({ op: 'connect', url: args.url, options: args.options }),
    subscribe: (topic) => call({ op: 'subscribe', topic }),
    unsubscribe: (topic) => call({ op: 'unsubscribe', topic }),
    publish: (topic, payload, retain = false) =>
      call({ op: 'publish', topic, payload, retain }, [payload.buffer]),
    disconnect: () => call({ op: 'disconnect' }),
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

/**
 * Preferred adapter for browser runtimes: MQTT inside a dedicated Worker
 * (timers unthrottled by tab visibility). Falls back to the inline in-page
 * adapter when Workers are unavailable (tests/jsdom, exotic embeds).
 */
export function createDefaultMqttAdapter(): BrowserMqttAdapter {
  if (typeof Worker !== 'undefined') {
    try {
      return createWorkerMqttAdapter(
        () =>
          new Worker(new URL('./mqtt-connection.worker.ts', import.meta.url), {
            type: 'module',
          }) as unknown as MqttWorkerLike,
      )
    } catch (error) {
      recordMqttDiag('mqtt-worker-adapter', 'worker:create-failed-fallback-inline', {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      })
    }
  } else {
    recordMqttDiag('mqtt-worker-adapter', 'worker:unavailable-fallback-inline')
  }
  return createBrowserMqttAdapter()
}
