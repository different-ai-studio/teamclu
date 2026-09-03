import { describe, it, expect } from 'vitest'
import { createBrowserMqttAdapter } from '@/lib/mqtt/browser-mqtt-adapter'

function makeFakeClient() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
  return {
    on(e: string, h: (...a: unknown[]) => void) { (handlers[e] ??= []).push(h); return this },
    once(e: string, h: (...a: unknown[]) => void) { (handlers[e] ??= []).push(h); return this },
    removeListener(e: string, h: (...a: unknown[]) => void) {
      handlers[e] = (handlers[e] ?? []).filter((x) => x !== h); return this
    },
    subscribe(_t: string, _opts: { qos: number }, cb: (e?: Error | null) => void) { cb(null) },
    unsubscribe(_t: string, cb: (e?: Error | null) => void) { cb(null) },
    publish(_t: string, _p: unknown, _o: unknown, cb: (e?: Error | null) => void) { cb(null) },
    end(_f: boolean, _o: unknown, cb: () => void) { cb() },
    emit(e: string, ...a: unknown[]) { (handlers[e] ?? []).forEach((h) => h(...a)) },
  }
}

describe('createBrowserMqttAdapter', () => {
  it('resolves connect on client connect event and relays messages', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const got: { topic: string; payload: Uint8Array }[] = []
    adapter.onMessage((m) => got.push(m))
    const p = adapter.connect({ url: 'ws://broker:8083/mqtt' })
    fake.emit('connect')
    await p
    fake.emit('message', 'amux/t/a/x', new Uint8Array([1, 2, 3]))
    expect(got).toHaveLength(1)
    expect(Array.from(got[0].payload)).toEqual([1, 2, 3])
  })

  it('rejects connect on error event', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const p = adapter.connect({ url: 'ws://b:8083' })
    fake.emit('error', new Error('bad creds'))
    await expect(p).rejects.toThrow('bad creds')
  })

  it('reports connection state transitions', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const states: string[] = []
    adapter.onConnectionState((s) => states.push(s))
    const p = adapter.connect({ url: 'ws://b:8083' })
    fake.emit('connect'); await p
    fake.emit('close')
    expect(states).toEqual(['connecting', 'connected', 'disconnected'])
  })

  it('keeps the mqtt.js client across automatic reconnects', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const states: string[] = []
    adapter.onConnectionState((s) => states.push(s))

    const p = adapter.connect({ url: 'ws://b:8083', options: { reconnectPeriod: 3000 } })
    fake.emit('connect')
    await p

    fake.emit('close')
    fake.emit('reconnect')
    fake.emit('connect')

    await expect(adapter.publish('amux/team/actor/rpc/req', new Uint8Array([1]), false))
      .resolves.toBeUndefined()
    expect(states).toEqual(['connecting', 'connected', 'disconnected', 'connecting', 'connected'])
  })

  it('relays post-connect errors to onError subscribers', async () => {
    const fake = makeFakeClient()
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const errors: string[] = []
    adapter.onError!((m) => errors.push(m))

    const p = adapter.connect({ url: 'ws://b:8083', options: { reconnectPeriod: 3000 } })
    fake.emit('connect')
    await p

    // Auth refusal during an automatic reconnect attempt.
    fake.emit('error', new Error('Connection refused: Bad User Name or Password'))
    expect(errors).toEqual(['Connection refused: Bad User Name or Password'])
  })

  it('unsubscribes from a topic when connected', async () => {
    const fake = makeFakeClient()
    const unsubCalls: string[] = []
    fake.unsubscribe = (topic: string, cb: (e?: Error | null) => void) => {
      unsubCalls.push(topic)
      cb(null)
    }
    const adapter = createBrowserMqttAdapter({ createClient: () => fake as never })
    const p = adapter.connect({ url: 'ws://b:8083' })
    fake.emit('connect')
    await p

    await adapter.unsubscribe('amux/team-1/session/session-1/live')
    expect(unsubCalls).toEqual(['amux/team-1/session/session-1/live'])
  })
})
