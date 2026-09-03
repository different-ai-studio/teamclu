import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getDaemonMqttConnected = vi.hoisted(() => vi.fn<() => Promise<boolean | null>>())
const probeListeners = vi.hoisted(() => new Set<() => void>())

const noteLocalDaemonSignals = vi.hoisted(() => vi.fn())

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({ getDaemonMqttConnected }))
vi.mock('@/lib/agent/agent-device-reachability', () => ({ noteLocalDaemonSignals }))
vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'actor-1',
}))
vi.mock('@/lib/daemon/daemon-probe-signal', () => ({
  onDaemonProbeRequested: (fn: () => void) => {
    probeListeners.add(fn)
    return () => probeListeners.delete(fn)
  },
}))

import {
  subscribeDaemonMqttStatus,
  useDaemonMqttStatusStore,
  __resetDaemonMqttStatusForTests,
} from '@/stores/daemon-mqtt-status'

describe('daemon-mqtt-status store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    probeListeners.clear()
    getDaemonMqttConnected.mockReset()
    getDaemonMqttConnected.mockResolvedValue(true)
    noteLocalDaemonSignals.mockClear()
    __resetDaemonMqttStatusForTests()
  })

  afterEach(() => {
    __resetDaemonMqttStatusForTests()
    vi.useRealTimers()
  })

  it('polls immediately on first subscribe and publishes the result', async () => {
    const release = subscribeDaemonMqttStatus()
    expect(getDaemonMqttConnected).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    const state = useDaemonMqttStatusStore.getState()
    expect(state.connected).toBe(true)
    expect(state.uiConnected).toBe(true)
    release()
  })

  it('keeps the initial false result as checking while MQTT finishes starting', async () => {
    getDaemonMqttConnected.mockReset()
    getDaemonMqttConnected.mockResolvedValueOnce(false).mockResolvedValue(true)

    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(useDaemonMqttStatusStore.getState().connected).toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(getDaemonMqttConnected).toHaveBeenCalledTimes(2)
    expect(useDaemonMqttStatusStore.getState().connected).toBe(true)
    release()
  })

  it('runs a single shared poll no matter how many consumers subscribe', async () => {
    const a = subscribeDaemonMqttStatus()
    const b = subscribeDaemonMqttStatus()
    // This is the #522 fix: two views must not each drive their own interval,
    // or they drift apart by up to a full poll period.
    expect(getDaemonMqttConnected).toHaveBeenCalledTimes(1)
    a()
    b()
  })

  it('keeps polling while one consumer remains and stops after the last leaves', async () => {
    const a = subscribeDaemonMqttStatus()
    const b = subscribeDaemonMqttStatus()
    getDaemonMqttConnected.mockClear()

    a()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getDaemonMqttConnected.mock.calls.length).toBeGreaterThan(0)

    b()
    getDaemonMqttConnected.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getDaemonMqttConnected).not.toHaveBeenCalled()
  })

  it('resets to unknown once the last consumer unsubscribes', async () => {
    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(useDaemonMqttStatusStore.getState().connected).toBe(true)
    release()
    const state = useDaemonMqttStatusStore.getState()
    expect(state.connected).toBeNull()
    expect(state.uiConnected).toBeNull()
    expect(state.falseStreak).toBe(0)
  })

  it('is idempotent when a release function is called twice', async () => {
    const a = subscribeDaemonMqttStatus()
    const b = subscribeDaemonMqttStatus()
    a()
    a()
    getDaemonMqttConnected.mockClear()
    // `b` is still subscribed, so the double release must not have torn down.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getDaemonMqttConnected.mock.calls.length).toBeGreaterThan(0)
    b()
  })

  it('warms the reachability cache on every tick, not only when the value flips', async () => {
    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(noteLocalDaemonSignals).toHaveBeenCalledTimes(1)

    // Same value on the next tick: the cache has a short TTL, so it must still
    // be re-stamped or the sync runtime-start gate reads an expired entry.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(noteLocalDaemonSignals).toHaveBeenCalledTimes(2)
    expect(noteLocalDaemonSignals).toHaveBeenLastCalledWith({
      actorId: 'actor-1',
      daemonMqttConnected: true,
    })
    release()
  })

  it('re-probes on a daemon probe request without waiting out the interval', async () => {
    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    getDaemonMqttConnected.mockClear()
    getDaemonMqttConnected.mockResolvedValue(false)

    probeListeners.forEach((fn) => fn())
    await vi.advanceTimersByTimeAsync(0)

    expect(getDaemonMqttConnected).toHaveBeenCalledTimes(1)
    const state = useDaemonMqttStatusStore.getState()
    expect(state.connected).toBe(false)
    // One transient false after a stable true — UI stays up until debounce trips.
    expect(state.uiConnected).toBe(true)
    expect(state.falseStreak).toBe(1)
    release()
  })

  it('debounces UI disconnect until consecutive false polls', async () => {
    getDaemonMqttConnected.mockResolvedValue(false)
    const release = subscribeDaemonMqttStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(useDaemonMqttStatusStore.getState().uiConnected).toBeNull()

    getDaemonMqttConnected.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useDaemonMqttStatusStore.getState().uiConnected).toBe(true)

    getDaemonMqttConnected.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useDaemonMqttStatusStore.getState().connected).toBe(false)
    expect(useDaemonMqttStatusStore.getState().uiConnected).toBe(true)
    expect(useDaemonMqttStatusStore.getState().falseStreak).toBe(1)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(useDaemonMqttStatusStore.getState().uiConnected).toBe(false)
    expect(useDaemonMqttStatusStore.getState().falseStreak).toBe(2)

    getDaemonMqttConnected.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useDaemonMqttStatusStore.getState().uiConnected).toBe(true)
    expect(useDaemonMqttStatusStore.getState().falseStreak).toBe(0)
    release()
  })
})
