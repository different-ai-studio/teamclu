/**
 * 资料库 is fetched on demand, so a teammate's upload is only ever LISTED on
 * this device until someone asks for it. Before this, the tree drew only what
 * was on disk: two members looking at the same 资料库 saw two unrelated trees,
 * and nothing either of them could click would change that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

const h = vi.hoisted(() => ({
  listKnownDocuments: vi.fn(),
  fetchDocuments: vi.fn(),
  expandDirectory: vi.fn(),
  selectFile: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: unknown) => (typeof fallback === 'string' ? fallback : _key),
  }),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}))
vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  copyToClipboard: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
// Registers native drag-drop listeners, which need a real Tauri webview.
vi.mock('../file-tree/use-os-file-drop', () => ({ useOsFileDrop: () => {} }))
vi.mock('../system-clipboard-files', () => ({
  hasSystemClipboardFiles: vi.fn(async () => false),
  writeSystemClipboardFiles: vi.fn(),
}))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  listKnownDocuments: h.listKnownDocuments,
  fetchDocuments: h.fetchDocuments,
}))
vi.mock('@/lib/team/team-permissions', () => ({
  useTeamPermissions: () => ({ canManageTeam: false }),
}))

// A real zustand store, so `setState` from the tree re-renders the tree.
vi.mock('@/stores/workspace', async () => {
  const { create } = await import('zustand')
  return {
    useWorkspaceStore: create(() => ({
      fileTree: [],
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      selectedFile: null,
      selectedFiles: [],
      workspacePath: '/work',
      focusedPath: null,
      selectFile: h.selectFile,
      selectFileRange: vi.fn(),
      toggleFileSelection: vi.fn(),
      expandDirectory: h.expandDirectory,
      collapseDirectory: vi.fn(),
      setFocusedPath: vi.fn(),
      pushUndo: vi.fn(),
      refreshFileTree: vi.fn(async () => {}),
      revealFile: vi.fn(async () => {}),
      clearSelection: vi.fn(),
      clipboardPaths: [],
      clipboardMode: null,
      setClipboard: vi.fn(),
      pasteFiles: vi.fn(async () => false),
    })),
  }
})

vi.mock('../FileTreeNode', () => ({
  FileTreeItem: ({ node, compactName, onSelectFile, onExpandDirectory, isNotDownloaded }: any) => (
    <div
      data-testid={`tree-item-${compactName || node.name}`}
      data-not-downloaded={isNotDownloaded ? 'yes' : 'no'}
      onClick={() => (node.type === 'file' ? onSelectFile(node.path) : onExpandDirectory(node.path))}
    >
      {compactName || node.name}
    </div>
  ),
  InlineInput: () => null,
}))

import { FileTree } from '@/components/workspace/FileTree'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamConflictsStore } from '@/stores/team-conflicts'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useOssSyncStore } from '@/stores/oss-sync'

const SYNC_ROOT = '/home/u/.amuxd/teams/t1/shared/team-sync'
const DOCS = `${SYNC_ROOT}/documents`

/** The reported tree: this member's own folder on disk, nothing else. */
function onDiskTree() {
  return [
    {
      name: 'documents',
      path: DOCS,
      type: 'directory' as const,
      children: [
        {
          name: '运营部',
          path: `${DOCS}/运营部`,
          type: 'directory' as const,
          children: [{ name: 'index.md', path: `${DOCS}/运营部/index.md`, type: 'file' as const }],
        },
      ],
    },
  ]
}

describe('FileTree with listed documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.listKnownDocuments.mockResolvedValue([
      { path: 'documents/untitled.md', version: 1, size: 6 },
      { path: 'documents/SOP/门店运营/手册.md', version: 1, size: 2091 },
    ])
    h.fetchDocuments.mockResolvedValue(1)
    h.expandDirectory.mockResolvedValue(undefined)
    h.selectFile.mockResolvedValue(undefined)
    useWorkspaceStore.setState({ expandedPaths: new Set([DOCS, `${DOCS}/运营部`]) })
    useTeamConflictsStore.setState({ syncRoot: SYNC_ROOT } as never)
    useCurrentTeamStore.setState({ team: { id: 'team-1' } } as never)
    useOssSyncStore.setState({ lastSyncAt: '2026-09-17T02:00:00Z' })
  })

  it('shows what a teammate uploaded next to what is on disk, marked as not downloaded', async () => {
    render(<FileTree nodes={onDiskTree()} rootPath={SYNC_ROOT} />)

    const listedFile = await screen.findByTestId('tree-item-untitled.md')
    expect(listedFile.dataset.notDownloaded).toBe('yes')
    expect(screen.getByTestId('tree-item-SOP').dataset.notDownloaded).toBe('yes')
    expect(screen.getByTestId('tree-item-index.md').dataset.notDownloaded).toBe('no')
    expect(h.listKnownDocuments).toHaveBeenCalledWith('team-1')
  })

  it('opens a listed folder without reading a directory that is not there', async () => {
    render(<FileTree nodes={onDiskTree()} rootPath={SYNC_ROOT} />)

    fireEvent.click(await screen.findByTestId('tree-item-SOP'))

    expect(await screen.findByTestId('tree-item-门店运营')).toBeTruthy()
    expect(h.expandDirectory).not.toHaveBeenCalledWith(`${DOCS}/SOP`)
  })

  it('clicking a listed file downloads it, then opens it', async () => {
    render(<FileTree nodes={onDiskTree()} rootPath={SYNC_ROOT} />)

    fireEvent.click(await screen.findByTestId('tree-item-untitled.md'))

    await waitFor(() => expect(h.selectFile).toHaveBeenCalledWith(`${DOCS}/untitled.md`))
    expect(h.fetchDocuments).toHaveBeenCalledWith('team-1', ['documents/untitled.md'])
    expect(h.fetchDocuments.mock.invocationCallOrder[0]).toBeLessThan(
      h.selectFile.mock.invocationCallOrder[0],
    )
  })

  // The daemon answers 200 with `fetched: 0` when the pull itself failed.
  it('does not open a listed file that did not arrive', async () => {
    h.fetchDocuments.mockResolvedValue(0)
    render(<FileTree nodes={onDiskTree()} rootPath={SYNC_ROOT} />)

    fireEvent.click(await screen.findByTestId('tree-item-untitled.md'))

    await waitFor(() => expect(h.fetchDocuments).toHaveBeenCalled())
    await waitFor(() => expect(h.listKnownDocuments).toHaveBeenCalledTimes(2))
    expect(h.selectFile).not.toHaveBeenCalled()
  })

  // A sync adds to the listing without writing anything to disk, so no file
  // watcher will ever announce it. The tree has to re-read on the sync itself.
  it('re-reads the listing when a sync completes', async () => {
    render(<FileTree nodes={onDiskTree()} rootPath={SYNC_ROOT} />)
    await screen.findByTestId('tree-item-untitled.md')
    expect(screen.queryByTestId('tree-item-new.pdf')).toBeNull()

    h.listKnownDocuments.mockResolvedValue([
      { path: 'documents/untitled.md', version: 1, size: 6 },
      { path: 'documents/new.pdf', version: 1, size: 10 },
    ])
    act(() => {
      useOssSyncStore.setState({ lastSyncAt: '2026-09-17T02:05:00Z' })
    })

    expect(await screen.findByTestId('tree-item-new.pdf')).toBeTruthy()
  })
})
