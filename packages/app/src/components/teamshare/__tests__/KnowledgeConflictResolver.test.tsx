import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

// Two call shapes in this component: t(key, 'fallback') and
// t(key, { defaultValue, ...vars }). Both have to render as a string, or React
// throws on an object child and the test failure says nothing useful.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: unknown) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object' && 'defaultValue' in arg) {
        return String((arg as { defaultValue: unknown }).defaultValue)
      }
      return key
    },
  }),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const { toastSuccess, toastError, readTextFile, closeWhere, load, resolve, absPathFor } =
  vi.hoisted(() => ({
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    readTextFile: vi.fn(),
    closeWhere: vi.fn(),
    load: vi.fn(),
    resolve: vi.fn(),
    // Stable identity on purpose: the component keys an effect on this, and the
    // real zustand store hands back the same function every render.
    absPathFor: (key: string) =>
      `/home/u/.amuxd/teams/t/shared/knowledge/${key.slice('knowledge/'.length)}`,
  }))
const KNOWLEDGE_DIR = '/home/u/.amuxd/teams/t/shared/knowledge'

vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: (p: string) => readTextFile(p) }))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { workspacePath: string | null }) => unknown) =>
    sel({ workspacePath: null }),
}))

vi.mock('@/stores/tabs', () => {
  const store = (sel: (s: { closeWhere: typeof closeWhere }) => unknown) => sel({ closeWhere })
  store.getState = () => ({ closeWhere })
  return { useTabsStore: store }
})

vi.mock('@/lib/team/team-skill-paths', () => ({
  teamSyncKeyForPath: (abs: string) =>
    abs.startsWith('/home/u/.amuxd/teams/t/shared/knowledge')
      ? `knowledge/${abs.slice('/home/u/.amuxd/teams/t/shared/knowledge'.length + 1)}`
      : null,
}))

const DOC = `${KNOWLEDGE_DIR}/note.md`
const SIDECAR = 'knowledge/.conflicts/note.conflict.1000.aabbccdd.md'

const conflict = { path: 'knowledge/note.md', sidecar: SIDECAR, conflictedAt: 1000, kind: 'oss' }

const storeState = vi.hoisted(() => ({
  entries: [] as unknown[],
  bySyncKey: {} as Record<string, unknown[]>,
  knowledgeDir: null as string | null,
}))
vi.mock('@/stores/team-conflicts', () => {
  const state = () => ({ ...storeState, load, resolve, absPathFor })
  const store = (sel: (s: ReturnType<typeof state>) => unknown) => sel(state())
  store.getState = state
  return { useTeamConflictsStore: store }
})

import { KnowledgeConflictResolver } from '../KnowledgeConflictResolver'

beforeEach(() => {
  vi.clearAllMocks()
  storeState.knowledgeDir = KNOWLEDGE_DIR
  storeState.entries = [conflict]
  storeState.bySyncKey = { 'knowledge/note.md': [conflict] }
  // The real store reloads after a decision; emulate the sidecar going away so
  // the "nothing left to decide" path is the one under test.
  resolve.mockImplementation(async () => {
    storeState.entries = []
    storeState.bySyncKey = {}
  })
  // "mine" comes from the sidecar; "theirs" is the document itself, which the
  // sync engine already overwrote with the cloud version.
  readTextFile.mockImplementation((p: string) =>
    Promise.resolve(p.includes('.conflict.') ? 'my draft' : 'cloud text'),
  )
})

describe('KnowledgeConflictResolver', () => {
  it('shows both sides of the conflict, reading the local copy from the sidecar', async () => {
    render(<KnowledgeConflictResolver path={DOC} />)

    await waitFor(() => expect(screen.getByText(/my draft/)).toBeTruthy())
    expect(screen.getByText(/cloud text/)).toBeTruthy()
    expect(readTextFile).toHaveBeenCalledWith(
      `${KNOWLEDGE_DIR}/.conflicts/note.conflict.1000.aabbccdd.md`,
    )
    expect(readTextFile).toHaveBeenCalledWith(DOC)
  })

  it('keeps the local copy through a confirmation, naming the sidecar it decided', async () => {
    render(<KnowledgeConflictResolver path={DOC} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine, overwrite cloud' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }))

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(conflict, 'keepLocal'))
    // Nothing left to decide → the tab closes itself rather than sitting on an
    // empty state the user has to notice and dismiss.
    await waitFor(() => expect(closeWhere).toHaveBeenCalled())
  })

  it('discards the local copy on the other choice', async () => {
    render(<KnowledgeConflictResolver path={DOC} />)

    fireEvent.click(screen.getByRole('button', { name: 'Discard mine, keep cloud' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard mine' }))

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(conflict, 'keepRemote'))
  })

  it('still offers the decision when the document cannot be previewed', async () => {
    readTextFile.mockRejectedValue(new Error('binary'))
    render(<KnowledgeConflictResolver path={DOC} />)

    await waitFor(() =>
      expect(screen.getByText(/Preview unavailable/)).toBeTruthy(),
    )
    expect(screen.getByRole('button', { name: 'Keep mine, overwrite cloud' })).toBeTruthy()
  })

  it('says so when the conflict is already gone', () => {
    storeState.bySyncKey = {}
    render(<KnowledgeConflictResolver path={DOC} />)
    expect(screen.getByText(/no conflict waiting/)).toBeTruthy()
  })
})
