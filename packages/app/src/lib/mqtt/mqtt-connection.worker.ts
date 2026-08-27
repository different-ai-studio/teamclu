/// <reference lib="webworker" />
// Dedicated Worker that owns the mqtt.js client. Chrome throttles page timers
// (hidden tab / side panel / occluded window) which starves mqtt.js keepalive
// PINGREQs and gets the connection kicked by the broker after 1.5×keepalive.
// Worker timers are not throttled, so the keepalive loop keeps the WS alive
// regardless of page visibility. The page talks to this worker through the
// small RPC protocol below (see worker-mqtt-adapter.ts for the client side).
import { createBrowserMqttAdapter } from './browser-mqtt-adapter'
import type { BrowserMqttConnectOptions } from './browser-mqtt-adapter'

export type MqttWorkerRequest =
  | { id: number; op: 'connect'; url: string; options?: BrowserMqttConnectOptions }
  | { id: number; op: 'subscribe'; topic: string }
  | { id: number; op: 'unsubscribe'; topic: string }
  | { id: number; op: 'publish'; topic: string; payload: Uint8Array; retain: boolean }
  | { id: number; op: 'disconnect' }

export type MqttWorkerEvent =
  | { kind: 'result'; id: number; ok: true }
  | { kind: 'result'; id: number; ok: false; error: string }
  | { kind: 'message'; topic: string; payload: Uint8Array }
  | { kind: 'state'; state: 'connecting' | 'connected' | 'disconnected' }
  | { kind: 'error'; message: string }

const scope = self as unknown as {
  postMessage(data: MqttWorkerEvent, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<MqttWorkerRequest>) => void) | null
}

const adapter = createBrowserMqttAdapter()

adapter.onMessage((m) => {
  // The adapter hands us a fresh copy of the payload, safe to transfer.
  scope.postMessage({ kind: 'message', topic: m.topic, payload: m.payload }, [m.payload.buffer])
})
adapter.onConnectionState((state) => {
  scope.postMessage({ kind: 'state', state })
})
adapter.onError?.((message) => {
  scope.postMessage({ kind: 'error', message })
})

scope.onmessage = async (e: MessageEvent<MqttWorkerRequest>) => {
  const req = e.data
  try {
    switch (req.op) {
      case 'connect':
        await adapter.connect({ url: req.url, options: req.options })
        break
      case 'subscribe':
        await adapter.subscribe(req.topic)
        break
      case 'unsubscribe':
        await adapter.unsubscribe(req.topic)
        break
      case 'publish':
        await adapter.publish(req.topic, req.payload, req.retain)
        break
      case 'disconnect':
        await adapter.disconnect()
        break
    }
    scope.postMessage({ kind: 'result', id: req.id, ok: true })
  } catch (err) {
    scope.postMessage({
      kind: 'result',
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
