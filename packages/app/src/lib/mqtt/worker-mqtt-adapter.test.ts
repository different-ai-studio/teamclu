import { describe, it, expect } from 'vitest'
import { createWorkerMqttAdapter, type MqttWorkerLike } from '@/lib/mqtt/worker-mqtt-adapter'
import type { MqttWorkerEvent, MqttWorkerRequest } from '@/lib/mqtt/mqtt-connection.worker'

function makeFakeWorker() {
  const sent: MqttWorkerRequest[] = []
  let onMessage: ((e: MessageEvent<MqttWorkerEvent>) => void) | null = null
  let onError: ((e: ErrorEvent) => void) | null = null
  const worker: MqttWorkerLike = {
    postMessage(data: MqttWorkerRequest) { sent.push(data) },
    addEventListener(type: string, handler: unknown) {
      if (type === 'message') onMessage = handler as typeof onMessage
      if (type === 'error') onError = handler as typeof onError
    },
    terminate() {},
  } as MqttWorkerLike
  return {
    worker,
    sent,
    emit(ev: MqttWorkerEvent) { onMessage!({ data: ev } as MessageEvent<MqttWorkerEvent>) },
    emitError(message: string) { onError!({ message } as ErrorEvent) },
  }
}

describe('createWorkerMqttAdapter', () => {
  it('forwards connect over RPC and resolves on ok result', async () => {
    const fake = makeFakeWorker()
    const adapter = createWorkerMqttAdapter(() => fake.worker)
    const p = adapter.connect({ url: 'ws://b:8083/mqtt', options: { keepalive: 30 } })
    expect(fake.sent).toEqual([
      { id: 1, op: 'connect', url: 'ws://b:8083/mqtt', options: { keepalive: 30 } },
    ])
    fake.emit({ kind: 'result', id: 1, ok: true })
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects the matching pending call on error result', async () => {
    const fake = makeFakeWorker()
    const adapter = createWorkerMqttAdapter(() => fake.worker)
    const p = adapter.connect({ url: 'ws://b:8083/mqtt' })
    fake.emit({ kind: 'result', id: 1, ok: false, error: 'bad creds' })
    await expect(p).rejects.toThrow('bad creds')
  })

  it('relays message, state and error events', () => {
    const fake = makeFakeWorker()
    const adapter = createWorkerMqttAdapter(() => fake.worker)
    // Instantiate the worker via a first call so event wiring exists.
    void adapter.connect({ url: 'ws://b' })

    const messages: { topic: string; payload: Uint8Array }[] = []
    const states: string[] = []
    const errors: string[] = []
    adapter.onMessage((m) => messages.push(m))
    adapter.onConnectionState((s) => states.push(s))
    adapter.onError!((m) => errors.push(m))

    fake.emit({ kind: 'state', state: 'connecting' })
    fake.emit({ kind: 'state', state: 'connected' })
    fake.emit({ kind: 'message', topic: 'amux/t/a/x', payload: new Uint8Array([7]) })
    fake.emit({ kind: 'error', message: 'not authorized' })

    expect(states).toEqual(['connecting', 'connected'])
    expect(messages).toEqual([{ topic: 'amux/t/a/x', payload: new Uint8Array([7]) }])
    expect(errors).toEqual(['not authorized'])
  })

  it('forwards unsubscribe over RPC and resolves on ok result', async () => {
    const fake = makeFakeWorker()
    const adapter = createWorkerMqttAdapter(() => fake.worker)
    const p = adapter.unsubscribe('amux/t/session/s1/live')
    expect(fake.sent).toEqual([{ id: 1, op: 'unsubscribe', topic: 'amux/t/session/s1/live' }])
    fake.emit({ kind: 'result', id: 1, ok: true })
    await expect(p).resolves.toBeUndefined()
  })

  it('fails pending calls and reports disconnected on worker crash', async () => {
    const fake = makeFakeWorker()
    const adapter = createWorkerMqttAdapter(() => fake.worker)
    const states: string[] = []
    const errors: string[] = []
    adapter.onConnectionState((s) => states.push(s))
    adapter.onError!((m) => errors.push(m))

    const p = adapter.connect({ url: 'ws://b' })
    fake.emitError('worker exploded')

    await expect(p).rejects.toThrow('worker exploded')
    expect(states).toEqual(['disconnected'])
    expect(errors).toHaveLength(1)
  })
})
