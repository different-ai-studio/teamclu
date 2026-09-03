import { describe, expect, it, vi } from 'vitest'
import { createSharedModuleLeaseManager } from '@/lib/shared-module-lease'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('shared module lease manager', () => {
  it('rejects duplicate owner ids instead of allowing premature cleanup', async () => {
    const manager = createSharedModuleLeaseManager({
      key: (value: string) => value,
      setup: async () => undefined,
    })
    const first = manager.acquire('team-1', 'owner-a')
    await first.ready

    expect(() => manager.acquire('team-1', 'owner-a')).toThrow(/owner/i)
    first.release()
  })

  it('fully deactivates a failed attempt and retries while the lease is owned', async () => {
    vi.useFakeTimers()
    const cleanup = vi.fn()
    const onDeactivate = vi.fn()
    let attempts = 0
    const manager = createSharedModuleLeaseManager({
      key: (value: string) => value,
      retryDelaysMs: [100],
      onDeactivate,
      setup: async (_context: string, controls) => {
        attempts += 1
        controls.setCleanup(cleanup)
        if (attempts === 1) throw new Error('transient subscribe failure')
      },
    })

    try {
      const lease = manager.acquire('team-1', 'owner-a')
      await vi.advanceTimersByTimeAsync(100)
      await lease.ready
      expect(attempts).toBe(2)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(onDeactivate).toHaveBeenCalledTimes(1)
      expect(manager.isReady()).toBe(true)
      lease.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry after the pending lease is released', async () => {
    vi.useFakeTimers()
    const setup = vi.fn(async () => {
      throw new Error('subscribe failed')
    })
    const manager = createSharedModuleLeaseManager({
      key: (value: string) => value,
      retryDelaysMs: [100, 200],
      setup,
    })

    try {
      const lease = manager.acquire('team-1', 'owner-a')
      await vi.advanceTimersByTimeAsync(0)
      lease.release()
      await vi.advanceTimersByTimeAsync(500)
      await lease.ready
      expect(setup).toHaveBeenCalledTimes(1)
      expect(manager.isReady()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('shares one setup and releases it only after the final same-context owner', async () => {
    const gate = deferred()
    const cleanup = vi.fn()
    const setup = vi.fn(async (_context: string, controls) => {
      controls.setCleanup(cleanup)
      await gate.promise
    })
    const manager = createSharedModuleLeaseManager({ key: (value: string) => value, setup })

    const a = manager.acquire('team-1', 'owner-a')
    const b = manager.acquire('team-1', 'owner-b')
    expect(setup).toHaveBeenCalledTimes(1)

    a.release()
    expect(cleanup).not.toHaveBeenCalled()
    gate.resolve()
    await b.ready
    expect(manager.isReady()).toBe(true)

    b.release()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(manager.isReady()).toBe(false)
  })

  it('does not let a released pending generation tear down a replacement', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const firstCleanup = vi.fn()
    const secondCleanup = vi.fn()
    let setupCount = 0
    const manager = createSharedModuleLeaseManager({
      key: (value: string) => value,
      setup: async (_context: string, controls) => {
        setupCount += 1
        if (setupCount === 1) {
          controls.setCleanup(firstCleanup)
          await firstGate.promise
        } else {
          controls.setCleanup(secondCleanup)
          await secondGate.promise
        }
      },
    })

    const a = manager.acquire('team-1', 'owner-a')
    a.release()
    const b = manager.acquire('team-1', 'owner-b')
    expect(firstCleanup).toHaveBeenCalledTimes(1)

    firstGate.resolve()
    await a.ready
    expect(secondCleanup).not.toHaveBeenCalled()

    secondGate.resolve()
    await b.ready
    expect(manager.isReady()).toBe(true)
    a.release()
    expect(manager.isReady()).toBe(true)
    b.release()
    expect(secondCleanup).toHaveBeenCalledTimes(1)
  })

  it('ignores old-context releases after a new context takes ownership', async () => {
    const cleanups = new Map<string, ReturnType<typeof vi.fn>>()
    const manager = createSharedModuleLeaseManager({
      key: (value: string) => value,
      setup: async (context: string, controls) => {
        const cleanup = vi.fn()
        cleanups.set(context, cleanup)
        controls.setCleanup(cleanup)
      },
    })

    const a = manager.acquire('team-a', 'owner-a')
    await a.ready
    const b = manager.acquire('team-b', 'owner-b')
    await b.ready
    expect(cleanups.get('team-a')).toHaveBeenCalledTimes(1)

    a.release()
    expect(manager.isReady()).toBe(true)
    expect(cleanups.get('team-b')).not.toHaveBeenCalled()
    b.release()
    expect(cleanups.get('team-b')).toHaveBeenCalledTimes(1)
  })
})
