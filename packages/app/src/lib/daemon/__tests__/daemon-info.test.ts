import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One `/v1/info` read is shared by everyone who asks at about the same time:
 * concurrent callers join it, and the answer is reused for a short window.
 */

const invoke = vi.hoisted(() => vi.fn(async () => ({ base_url: 'http://127.0.0.1:5555' })))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/utils', async (orig) => ({
  ...(await orig<typeof import('@/lib/utils')>()),
  isTauri: () => true,
}))

import { DAEMON_INFO_REUSE_MS, readDaemonInfo } from '../daemon-info'
import { getDaemonMqttConnected, getLocalDaemonActorId } from '../daemon-agent-admin'

const fetchMock = vi.fn()

function infoResponse(body: Record<string, unknown>) {
  return { ok: true, json: async () => body } as Response
}

describe('readDaemonInfo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => infoResponse({ actor_id: 'actor-1', mqtt_connected: true }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('folds the actor-id and MQTT reads of one check into a single request', async () => {
    const actorId = await getLocalDaemonActorId()
    const connected = await getDaemonMqttConnected()
    expect(actorId).toBe('actor-1')
    expect(connected).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets concurrent callers share the request in flight', async () => {
    await Promise.all([readDaemonInfo(), readDaemonInfo(), readDaemonInfo()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks again once the reuse window has passed', async () => {
    await readDaemonInfo()
    vi.setSystemTime(Date.now() + DAEMON_INFO_REUSE_MS + 1)
    fetchMock.mockImplementation(async () => infoResponse({ actor_id: 'actor-2' }))
    expect((await readDaemonInfo())?.actor_id).toBe('actor-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports an unreachable daemon as null, and does not ask again inside the window', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await readDaemonInfo()).toBeNull()
    expect(await getLocalDaemonActorId()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats a non-2xx answer as unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) } as Response)
    expect(await getDaemonMqttConnected()).toBeNull()
  })
})
