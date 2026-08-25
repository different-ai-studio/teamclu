import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: unknown, vars?: Record<string, unknown>) => {
      const fallback = typeof arg === 'string' ? arg : key
      const values = (typeof arg === 'object' ? arg : vars) as Record<string, unknown> | undefined
      return fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values?.[name] ?? ''))
    },
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { refresh, syncNow, openKnowledgeConflict, absPathFor } = vi.hoisted(() => ({
  refresh: vi.fn(() => Promise.resolve()),
  syncNow: vi.fn(() => Promise.resolve()),
  openKnowledgeConflict: vi.fn(),
  absPathFor: (key: string) => `/knowledge-root/${key.slice('knowledge/'.length)}`,
}))

vi.mock('@/lib/tabs/knowledge-tabs', () => ({ openKnowledgeConflict }))
const cloud = vi.hoisted(() => ({ available: true }))
vi.mock('@/hooks/use-team-cloud-sync', () => ({
  useTeamCloudSync: () => ({ available: cloud.available, syncing: false, syncNow }),
}))

const sync = vi.hoisted(() => ({
  syncing: false,
  progress: null as { phase: string; done: number; total: number } | null,
  lastSyncAt: null as string | null,
  failed: 0,
  lastError: null as string | null,
}))
vi.mock('@/stores/oss-sync', () => ({
  useOssSyncStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ ...sync, refresh }),
}))

const conflictState = vi.hoisted(() => ({
  entries: [] as { path: string; sidecar: string }[],
}))
const syncStatusState = vi.hoisted(() => ({
  localBySyncKey: {} as Record<string, string>,
  remoteBySyncKey: {} as Record<string, { version: number; deleted: boolean }>,
  stuckBySyncKey: {} as Record<string, { reason: string; attempts: number }>,
}))
const refreshSyncStatus = vi.hoisted(() => vi.fn())
vi.mock('@/stores/team-sync-status', () => ({
  useTeamSyncStatusStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ ...syncStatusState, refresh: refreshSyncStatus }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ selectFile: vi.fn() }),
}))
vi.mock('@/stores/team-conflicts', () => ({
  useTeamConflictsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ ...conflictState, absPathFor }),
}))

import { KnowledgeSyncFooter } from '../KnowledgeSyncFooter'

beforeEach(() => {
  vi.clearAllMocks()
  sync.syncing = false
  sync.progress = null
  sync.lastSyncAt = new Date(Date.now() - 120_000).toISOString()
  sync.failed = 0
  sync.lastError = null
  conflictState.entries = []
  syncStatusState.localBySyncKey = {}
  syncStatusState.remoteBySyncKey = {}
  syncStatusState.stuckBySyncKey = {}
  cloud.available = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('KnowledgeSyncFooter', () => {
  it('reports the last sync and runs one when clicked', () => {
    render(<KnowledgeSyncFooter />)

    expect(screen.getByText(/Synced/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('knowledge-sync-footer'))
    expect(syncNow).toHaveBeenCalled()
  })

  it('stays quiet for a sync that finishes before the bar would be readable', () => {
    vi.useFakeTimers()
    sync.syncing = true
    render(<KnowledgeSyncFooter />)

    // 250ms in: still nothing, because a bar that flashes is noise.
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(screen.queryByText(/Downloading|Checking/)).toBeNull()
  })

  it('shows the phase and the real count once a sync is slow enough to matter', () => {
    vi.useFakeTimers()
    sync.syncing = true
    sync.progress = { phase: 'pulling', done: 3, total: 12 }
    render(<KnowledgeSyncFooter />)

    act(() => {
      vi.advanceTimersByTime(350)
    })

    expect(screen.getByText('Downloading')).toBeTruthy()
    expect(screen.getByText('3/12')).toBeTruthy()
  })

  it('polls the daemon while a sync runs, and not when it is idle', () => {
    vi.useFakeTimers()
    sync.syncing = true
    const { unmount } = render(<KnowledgeSyncFooter />)
    refresh.mockClear() // the mount read is not what this is about

    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2)
    unmount()

    sync.syncing = false
    render(<KnowledgeSyncFooter />)
    refresh.mockClear()
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('leads with conflicts, and the list goes to the decision instead of syncing', async () => {
    conflictState.entries = [{ path: 'knowledge/note.md', sidecar: 'knowledge/note.conflict.1.a.md' }]
    render(<KnowledgeSyncFooter />)

    expect(screen.getByText('1 conflicts need a decision')).toBeTruthy()
    fireEvent.click(screen.getByTestId('knowledge-sync-footer'))

    // The bar opens what is waiting; the row is what acts.
    fireEvent.click(await screen.findByText('note.md'))
    expect(openKnowledgeConflict).toHaveBeenCalledWith('/knowledge-root/note.md', expect.any(String))
    // A conflict is not fixed by syncing again — that is what created it.
    expect(syncNow).not.toHaveBeenCalled()
  })

  it('lists a deleted document, which has no row in the tree to show', async () => {
    // The one case the badges cannot cover: the file is gone, so the only
    // places it can appear are its folder's colour and this list.
    syncStatusState.localBySyncKey = { 'knowledge/gone.md': 'deleted' }
    render(<KnowledgeSyncFooter />)

    fireEvent.click(screen.getByTestId('knowledge-sync-footer'))
    expect(await screen.findByText('gone.md')).toBeTruthy()
    expect(screen.getByText('deleted')).toBeTruthy()
  })

  it('names the file it cannot sync, and why', async () => {
    // "3 files cannot sync" is not something a person can act on.
    syncStatusState.stuckBySyncKey = {
      'knowledge/locked.md': { reason: 'AES-GCM decrypt failed', attempts: 4 },
    }
    render(<KnowledgeSyncFooter />)

    fireEvent.click(screen.getByTestId('knowledge-sync-footer'))
    expect(await screen.findByText('locked.md')).toBeTruthy()
    expect(screen.getByText(/retried 4× · AES-GCM decrypt failed/)).toBeTruthy()
  })

  it('does not offer a sync the app cannot run, but still opens what is waiting', async () => {
    // Team share not set up on this device: clicking would be a no-op, which is
    // worse than an obviously inert bar.
    cloud.available = false
    const { unmount } = render(<KnowledgeSyncFooter />)
    fireEvent.click(screen.getByTestId('knowledge-sync-footer'))
    expect(syncNow).not.toHaveBeenCalled()
    unmount()

    // A conflict is local, so it is decidable either way.
    conflictState.entries = [{ path: 'knowledge/note.md', sidecar: 'knowledge/note.conflict.1.a.md' }]
    render(<KnowledgeSyncFooter />)
    fireEvent.click(screen.getByTestId('knowledge-sync-footer'))
    fireEvent.click(await screen.findByText('note.md'))
    expect(openKnowledgeConflict).toHaveBeenCalled()
  })

  it('does not call a tick clean when files were left behind', () => {
    // The daemon returns Ok with failed > 0 and deliberately holds the cursor
    // back; presenting that as "Synced" is what hid the condition entirely.
    sync.failed = 3
    render(<KnowledgeSyncFooter />)

    expect(screen.getByText('3 files cannot sync · retrying')).toBeTruthy()
    expect(screen.queryByText(/Synced/)).toBeNull()
  })
})
