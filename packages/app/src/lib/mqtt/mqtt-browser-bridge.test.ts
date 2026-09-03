import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('mqtt-browser-bridge', () => {
  it('maps useTls=false to ws:// and includes /mqtt path', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    await mod.mqttConnect({ brokerHost: 'b.example', brokerPort: 8083, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: false })
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://b.example:8083/mqtt' }))
  })

  it('maps useTls=true to wss://', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    await mod.mqttConnect({ brokerHost: 'b', brokerPort: 8084, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: true })
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://b:8084/mqtt' }))
  })

  it('uses a persistent MQTT v5 session with mqtt.js auto reconnect for browser clients', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })

    await mod.mqttConnect({
      brokerHost: 'b',
      brokerPort: 443,
      username: '1e7ff051-d7d7-48a2-9a99-d164c1be9282',
      password: 'p',
      clientId: 'teamclu-1e7ff051-random',
      teamId: '68c9c97a-7393-494f-9b82-59364e7179ba',
      useTls: true,
    })

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        clientId: expect.stringMatching(/^teamclu-1e7ff051-68c9c97a-browser-[A-Za-z0-9_-]+$/),
        // Persistent session: broker keeps subscriptions + queued QoS1
        // messages across auto-reconnects within this page's lifetime.
        clean: false,
        protocolVersion: 5,
        properties: expect.objectContaining({ sessionExpiryInterval: 300 }),
        reconnectPeriod: 3000,
      }),
    }))
  })

  it('does not share browser MQTT clientId suffix through localStorage', async () => {
    localStorage.setItem('teamclu.browserMqtt.instanceId', 'shared')
    const randomUuid = vi.spyOn(crypto, 'randomUUID')

    randomUuid.mockReturnValueOnce('aaaa1111-0000-4000-8000-000000000000')
    vi.resetModules()
    const firstMod = await import('@/lib/mqtt/mqtt-browser-bridge')
    const firstConnect = vi.fn().mockResolvedValue(undefined)
    firstMod.__resetBrowserMqttForTest({
      adapter: { connect: firstConnect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    await firstMod.mqttConnect({ brokerHost: 'b', brokerPort: 443, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: true })

    randomUuid.mockReturnValueOnce('bbbb2222-0000-4000-8000-000000000000')
    vi.resetModules()
    const secondMod = await import('@/lib/mqtt/mqtt-browser-bridge')
    const secondConnect = vi.fn().mockResolvedValue(undefined)
    secondMod.__resetBrowserMqttForTest({
      adapter: { connect: secondConnect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    await secondMod.mqttConnect({ brokerHost: 'b', brokerPort: 443, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: true })

    expect(firstConnect.mock.calls[0]?.[0].options.clientId).toBe('teamclu-u-t-browser-aaaa1111')
    expect(secondConnect.mock.calls[0]?.[0].options.clientId).toBe('teamclu-u-t-browser-bbbb2222')
    randomUuid.mockRestore()
  })

  it('is idempotent: a second mqttConnect while connected does not reconnect', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    const args = { brokerHost: 'b', brokerPort: 443, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: true }
    await mod.mqttConnect(args)
    await mod.mqttConnect(args)
    // The MQTT connect effect can run twice; the surviving run must proceed to
    // wiring instead of throwing — so the adapter connects exactly once.
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('replaces the browser MQTT client when credentials change while connected', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect, onMessage: () => () => {}, onConnectionState: () => () => {} },
    })

    const args = { brokerHost: 'b', brokerPort: 443, username: 'u', clientId: 'c', teamId: 't', useTls: true }
    await mod.mqttConnect({ ...args, password: 'old-token' })
    await mod.mqttConnect({ ...args, password: 'fresh-token' })

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ password: 'fresh-token' }),
    }))
  })

  it('shares an in-flight connect for duplicate mqttConnect calls', async () => {
    let resolveConnect: (() => void) | null = null
    const connect = vi.fn(() => new Promise<void>((resolve) => {
      resolveConnect = resolve
    }))
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    const args = { brokerHost: 'b', brokerPort: 443, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: true }
    const first = mod.mqttConnect(args)
    const second = mod.mqttConnect(args)
    expect(connect).toHaveBeenCalledTimes(1)
    resolveConnect!()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect((await mod.mqttStatus()).connected).toBe(true)
  })

  it('does not let a stale in-flight connect overwrite a fresher credential connect', async () => {
    const resolvers: Array<() => void> = []
    const connect = vi.fn(() => new Promise<void>((resolve) => {
      resolvers.push(resolve)
    }))
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: { connect, subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn().mockResolvedValue(undefined), onMessage: () => () => {}, onConnectionState: () => () => {} },
    })
    const args = { brokerHost: 'b', brokerPort: 443, username: 'u', clientId: 'c', teamId: 't', useTls: true }

    const stale = mod.mqttConnect({ ...args, password: 'old-token' })
    const fresh = mod.mqttConnect({ ...args, password: 'fresh-token' })
    await Promise.resolve()
    expect(connect).toHaveBeenCalledTimes(2)
    resolvers[1]()
    await fresh
    resolvers[0]()
    await stale

    await mod.mqttConnect({ ...args, password: 'fresh-token' })
    expect(connect).toHaveBeenCalledTimes(2)
  })


  it('mqttStatus reflects disconnected state after onConnectionState fires disconnected', async () => {
    let connStateCb: ((s: 'connecting' | 'connected' | 'disconnected') => void) | null = null
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: {
        connect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
        publish: vi.fn(),
        disconnect: vi.fn(),
        onMessage: () => () => {},
        onConnectionState: (h) => { connStateCb = h; return () => {} },
      },
    })
    await mod.mqttConnect({ brokerHost: 'b', brokerPort: 1883, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: false })
    expect((await mod.mqttStatus()).connected).toBe(true)
    connStateCb!('disconnected')
    expect((await mod.mqttStatus()).connected).toBe(false)
  })

  it('mqttUnsubscribe sends broker UNSUB when connected', async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined)
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: {
        connect: vi.fn().mockResolvedValue(undefined),
        subscribe,
        unsubscribe,
        publish: vi.fn(),
        disconnect: vi.fn(),
        onMessage: () => () => {},
        onConnectionState: () => () => {},
      },
    })
    await mod.mqttConnect({
      brokerHost: 'b',
      brokerPort: 443,
      username: 'u',
      password: 'p',
      clientId: 'c',
      teamId: 't',
      useTls: true,
    })
    await mod.mqttSubscribe('amux/t/session/s1/live')
    await mod.mqttUnsubscribe('amux/t/session/s1/live')

    expect(unsubscribe).toHaveBeenCalledWith('amux/t/session/s1/live')
    expect((await mod.mqttStatus()).subscribedTopics).toEqual([])
  })

  it('listenForEnvelopes forwards adapter messages as IncomingEnvelope', async () => {
    let msgCb: ((m: { topic: string; payload: Uint8Array }) => void) | null = null
    const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
    mod.__resetBrowserMqttForTest({
      adapter: {
        connect: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn(), publish: vi.fn(), disconnect: vi.fn(),
        onMessage: (h) => { msgCb = h; return () => {} }, onConnectionState: () => () => {},
      },
    })
    const got: { topic: string; bytes: Uint8Array }[] = []
    await mod.listenForEnvelopes((e) => got.push(e))
    msgCb!({ topic: 'amux/x', payload: new Uint8Array([9]) })
    expect(got).toEqual([{ topic: 'amux/x', bytes: new Uint8Array([9]) }])
  })

  describe('subscribeBrowserMqttState', () => {
    beforeEach(async () => {
      const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
      mod.__resetBrowserMqttForTest()
    })

    it('fires handler when injected adapter emits a state change', async () => {
      let connStateCb: ((s: 'connecting' | 'connected' | 'disconnected') => void) | null = null
      const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
      mod.__resetBrowserMqttForTest({
        adapter: {
          connect: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn(),
          publish: vi.fn(),
          disconnect: vi.fn(),
          onMessage: () => () => {},
          onConnectionState: (h) => { connStateCb = h; return () => {} },
        },
      })

      const states: string[] = []
      mod.subscribeBrowserMqttState((s) => states.push(s))

      connStateCb!('connecting')
      connStateCb!('connected')
      connStateCb!('disconnected')

      expect(states).toEqual(['connecting', 'connected', 'disconnected'])
    })

    it('unsubscribe stops handler from receiving further events', async () => {
      let connStateCb: ((s: 'connecting' | 'connected' | 'disconnected') => void) | null = null
      const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
      mod.__resetBrowserMqttForTest({
        adapter: {
          connect: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn(),
          publish: vi.fn(),
          disconnect: vi.fn(),
          onMessage: () => () => {},
          onConnectionState: (h) => { connStateCb = h; return () => {} },
        },
      })

      const states: string[] = []
      const unsub = mod.subscribeBrowserMqttState((s) => states.push(s))
      connStateCb!('connected')
      unsub()
      connStateCb!('disconnected')

      expect(states).toEqual(['connected'])
    })

    it('subscribeBrowserMqttState also keeps mqttStatus internal flag in sync', async () => {
      let connStateCb: ((s: 'connecting' | 'connected' | 'disconnected') => void) | null = null
      const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
      mod.__resetBrowserMqttForTest({
        adapter: {
          connect: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn(),
          publish: vi.fn(),
          disconnect: vi.fn(),
          onMessage: () => () => {},
          onConnectionState: (h) => { connStateCb = h; return () => {} },
        },
      })

      mod.subscribeBrowserMqttState(() => {})
      connStateCb!('connected')
      expect((await mod.mqttStatus()).connected).toBe(true)
      connStateCb!('disconnected')
      expect((await mod.mqttStatus()).connected).toBe(false)
    })
  })

  describe('subscribeBrowserMqttError', () => {
    beforeEach(async () => {
      const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
      mod.__resetBrowserMqttForTest()
    })

    it('notifies error subscribers when mqttConnect rejects, and still rejects', async () => {
      const connectError = new Error('Connection refused')
      const mod = await import('@/lib/mqtt/mqtt-browser-bridge')
      mod.__resetBrowserMqttForTest({
        adapter: {
          connect: vi.fn().mockRejectedValue(connectError),
          subscribe: vi.fn(),
          publish: vi.fn(),
          disconnect: vi.fn(),
          onMessage: () => () => {},
          onConnectionState: () => () => {},
        },
      })

      const errors: string[] = []
      mod.subscribeBrowserMqttError((msg) => errors.push(msg))

      await expect(
        mod.mqttConnect({ brokerHost: 'b', brokerPort: 1883, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: false })
      ).rejects.toThrow('Connection refused')

      expect(errors).toEqual(['Connection refused'])
    })

    it('error handler is cleared after __resetBrowserMqttForTest', async () => {
      const connectError = new Error('fail')
      const mod = await import('@/lib/mqtt/mqtt-browser-bridge')

      const errors: string[] = []
      mod.subscribeBrowserMqttError((msg) => errors.push(msg))

      // Reset clears the error subscribers
      mod.__resetBrowserMqttForTest({
        adapter: {
          connect: vi.fn().mockRejectedValue(connectError),
          subscribe: vi.fn(),
          publish: vi.fn(),
          disconnect: vi.fn(),
          onMessage: () => () => {},
          onConnectionState: () => () => {},
        },
      })

      await expect(
        mod.mqttConnect({ brokerHost: 'b', brokerPort: 1883, username: 'u', password: 'p', clientId: 'c', teamId: 't', useTls: false })
      ).rejects.toThrow()

      // No errors received since subscriber was cleared by reset
      expect(errors).toEqual([])
    })
  })
})
