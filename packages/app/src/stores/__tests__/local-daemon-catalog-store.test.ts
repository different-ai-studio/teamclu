import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchLocalDaemonCatalog = vi.hoisted(() => vi.fn())

vi.mock('@/lib/agent/local-daemon-model-catalog', () => ({ fetchLocalDaemonCatalog }))

import {
  ensureLocalDaemonCatalog,
  isSettledLocalCatalog,
  resetLocalDaemonCatalogForTests,
  shouldFetchLocalDaemonCatalog,
  useLocalDaemonCatalogStore,
  type LocalDaemonCatalogEntry,
} from '../local-daemon-catalog-store'

const entry = (
  status: LocalDaemonCatalogEntry['status'],
  fetchedAt: number,
): LocalDaemonCatalogEntry => ({ status, models: [], recentModels: [], fetchedAt })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('isSettledLocalCatalog', () => {
  it('treats "no entry yet" as unsettled, exactly like pending', () => {
    // Regression: a guard that only checked 'pending' sailed through the first
    // render — where no entry exists at all — and durably persisted
    // availableModels[0] before the device MRU could arrive, so every restart
    // snapped back to the first model in the list.
    expect(isSettledLocalCatalog(undefined)).toBe(false)
    expect(isSettledLocalCatalog('pending')).toBe(false)
  })

  it('counts every answer the probe can actually give as settled', () => {
    // 'unknown' included on purpose: we asked and learned nothing, so callers
    // should stop waiting and fall back rather than hang forever.
    expect(isSettledLocalCatalog('ready')).toBe(true)
    expect(isSettledLocalCatalog('empty')).toBe(true)
    expect(isSettledLocalCatalog('unknown')).toBe(true)
  })
})

describe('shouldFetchLocalDaemonCatalog', () => {
  it('fetches when nothing is cached, and never while one is in flight', () => {
    expect(shouldFetchLocalDaemonCatalog(undefined, 1_000)).toBe(true)
    expect(shouldFetchLocalDaemonCatalog(entry('pending', 0), 1_000_000)).toBe(false)
  })

  it('retries an empty answer far sooner than it re-reads a ready one', () => {
    // First install: the user is configuring a provider in another pane and the
    // pill should notice without a restart. A settled catalog needs no such
    // urgency.
    const now = 100_000
    expect(shouldFetchLocalDaemonCatalog(entry('empty', now - 16_000), now)).toBe(true)
    expect(shouldFetchLocalDaemonCatalog(entry('empty', now - 5_000), now)).toBe(false)

    expect(shouldFetchLocalDaemonCatalog(entry('ready', now - 16_000), now)).toBe(false)
    expect(shouldFetchLocalDaemonCatalog(entry('ready', now - 6 * 60_000), now)).toBe(true)
  })
})

describe('ensureLocalDaemonCatalog', () => {
  beforeEach(() => {
    fetchLocalDaemonCatalog.mockReset()
    resetLocalDaemonCatalogForTests()
  })

  const read = (path: string) => useLocalDaemonCatalogStore.getState().byWorkspacePath[path]


  // Switching the local agent restarts the daemon onto a different backend, so
  // the cached entry describes models the new one has never heard of. Without
  // `force` it stays valid for the full ready-refresh window and the picker
  // keeps offering them.
  it('re-probes a fresh ready entry when forced', async () => {
    useLocalDaemonCatalogStore.getState().setEntry('/w1', {
      status: 'ready',
      models: [{ id: 'opencode/big-pickle' } as never],
      recentModels: [],
      fetchedAt: Date.now(),
    })
    fetchLocalDaemonCatalog.mockResolvedValueOnce({
      status: 'models',
      backend: 'claude-code',
      models: [{ id: 'claude/sonnet' }],
      recentModels: [],
    })

    // Not due yet: without the flag this is a no-op.
    ensureLocalDaemonCatalog('/w1', 'claude-code')
    await settled()
    expect(fetchLocalDaemonCatalog).not.toHaveBeenCalled()

    ensureLocalDaemonCatalog('/w1', 'claude-code', { force: true })
    await settled()

    expect(fetchLocalDaemonCatalog).toHaveBeenCalledWith('/w1', 'claude-code')
    const after = useLocalDaemonCatalogStore.getState().byWorkspacePath['/w1']
    expect(after.status).toBe('ready')
    expect(after.models.map((m) => m.id)).toEqual(['claude/sonnet'])
  })

  it('drops a stale list when the daemon reports empty', async () => {
    // `empty` is authoritative — keeping old models would let the picker offer
    // something the daemon just said it cannot run.
    fetchLocalDaemonCatalog.mockResolvedValueOnce({
      status: 'models',
      backend: 'opencode',
      models: [{ id: 'prov/a' }],
      recentModels: ['prov/a'],
    })
    ensureLocalDaemonCatalog('/w1')
    await settled()

    useLocalDaemonCatalogStore.getState().setEntry('/w1', {
      ...read('/w1'),
      fetchedAt: 0,
    })
    fetchLocalDaemonCatalog.mockResolvedValueOnce({ status: 'empty', backend: 'opencode' })
    ensureLocalDaemonCatalog('/w1')
    await settled()

    expect(read('/w1').status).toBe('empty')
    expect(read('/w1').models).toEqual([])
  })

  it('keeps the last-known list when a probe merely fails to answer', async () => {
    // 'unknown' means we learned nothing — blanking the picker on a transient
    // daemon restart would be a regression the user would feel immediately.
    fetchLocalDaemonCatalog.mockResolvedValueOnce({
      status: 'models',
      backend: 'opencode',
      models: [{ id: 'prov/a' }],
      recentModels: [],
    })
    ensureLocalDaemonCatalog('/w1')
    await settled()

    useLocalDaemonCatalogStore.getState().setEntry('/w1', { ...read('/w1'), fetchedAt: 0 })
    fetchLocalDaemonCatalog.mockResolvedValueOnce({ status: 'unknown' })
    ensureLocalDaemonCatalog('/w1')
    await settled()

    expect(read('/w1').status).toBe('unknown')
    expect(read('/w1').models).toHaveLength(1)
  })

  it('collapses concurrent callers onto one request', async () => {
    // Every engaged pill calls this on render; N pills must not mean N probes.
    fetchLocalDaemonCatalog.mockResolvedValue({
      status: 'models',
      backend: 'opencode',
      models: [{ id: 'prov/a' }],
      recentModels: [],
    })
    ensureLocalDaemonCatalog('/w1')
    ensureLocalDaemonCatalog('/w1')
    ensureLocalDaemonCatalog('/w1')
    await settled()

    expect(fetchLocalDaemonCatalog).toHaveBeenCalledTimes(1)
  })

  it('runs a forced follow-up probe after an in-flight request settles', async () => {
    let resolveFirst!: (value: {
      status: 'models'
      backend: string
      models: Array<{ id: string }>
      recentModels: string[]
    }) => void
    fetchLocalDaemonCatalog
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce({
        status: 'models',
        backend: 'claude-code',
        models: [{ id: 'claude/sonnet' }],
        recentModels: [],
      })

    ensureLocalDaemonCatalog('/w1', 'opencode')
    ensureLocalDaemonCatalog('/w1', 'claude-code', { force: true })

    expect(fetchLocalDaemonCatalog).toHaveBeenCalledTimes(1)
    resolveFirst({
      status: 'models',
      backend: 'opencode',
      models: [{ id: 'opencode/big-pickle' }],
      recentModels: [],
    })
    await settled()
    await settled()

    expect(fetchLocalDaemonCatalog).toHaveBeenCalledTimes(2)
    expect(fetchLocalDaemonCatalog).toHaveBeenLastCalledWith('/w1', 'claude-code')
    expect(read('/w1').models.map((model) => model.id)).toEqual(['claude/sonnet'])
  })

  it('survives a throwing probe without breaking the pill it feeds', async () => {
    fetchLocalDaemonCatalog.mockRejectedValueOnce(new Error('daemon exploded'))
    ensureLocalDaemonCatalog('/w1')
    await settled()

    expect(read('/w1').status).toBe('unknown')
  })

  it('ignores a blank workspace path', () => {
    ensureLocalDaemonCatalog('   ')
    expect(fetchLocalDaemonCatalog).not.toHaveBeenCalled()
  })
})
