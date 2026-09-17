/**
 * The lock marks a folder that carries a permission rule of its own.
 *
 * Two things it must NOT do, both of which are about the same design rule —
 * the names of restricted folders are themselves sensitive:
 *
 *  - it is never drawn for a member who cannot manage the team (they never
 *    receive the rule list, so `isPermissionRestricted` is never true for them);
 *  - it is not repeated down the subtree, because descendants are drawn nested
 *    under the folder that already carries it.
 *
 * Both are decided by the caller, so what this file pins is the contract the
 * caller relies on: the flag, and only the flag, produces the marker.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileTreeItem, type FileTreeItemProps } from '../FileTreeNode'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _k),
  }),
}))

vi.mock('@/stores/oss-sync', () => ({ useOssSyncStore: () => undefined }))
vi.mock('@/stores/team-conflicts', () => ({ useTeamConflictsStore: () => undefined }))
vi.mock('@/stores/ui', () => ({ useUIStore: () => undefined }))

function props(overrides: Partial<FileTreeItemProps> = {}): FileTreeItemProps {
  const noop = () => {}
  return {
    node: { name: 'hr', path: '/vault/knowledge/hr', type: 'directory' },
    level: 0,
    isExpanded: false,
    isSelected: false,
    isLoading: false,
    onSelectFile: noop,
    onSelectFileRange: noop,
    onToggleFileSelection: noop,
    onExpandDirectory: noop,
    onCollapseDirectory: noop,
    onNewFile: noop,
    onNewFolder: noop,
    onRename: noop,
    onRenameConfirm: noop,
    onRenameCancel: noop,
    onDelete: noop,
    onCopyPath: noop,
    onCopyRelativePath: noop,
    onReveal: noop,
    onOpenDefault: noop,
    onOpenTerminal: noop,
    onAddToAgent: noop,
    onDragStart: noop,
    onDragOver: noop,
    onDragLeave: noop,
    onDragEnd: noop,
    onDrop: noop,
    onCut: noop,
    onCopy: noop,
    onPaste: noop,
    onDuplicate: noop,
    ...overrides,
  } as unknown as FileTreeItemProps
}

describe('FileTreeItem download state', () => {
  it('marks a listed-but-unfetched file', () => {
    render(<FileTreeItem {...props({ isNotDownloaded: true })} />)
    expect(screen.getByLabelText('Not downloaded')).toBeTruthy()
  })

  it('a failed download is marked differently from an unfetched one', () => {
    // The next action differs: one is "click and it appears", the other is
    // "clicking again will not help until the connection does".
    render(<FileTreeItem {...props({ isNotDownloaded: true, downloadFailed: true })} />)
    expect(screen.getByLabelText('Download failed')).toBeTruthy()
    expect(screen.queryByLabelText('Not downloaded')).toBeNull()
  })

  it('a downloaded file carries no marker — it is the normal case', () => {
    render(<FileTreeItem {...props()} />)
    expect(screen.queryByLabelText('Not downloaded')).toBeNull()
    expect(screen.queryByLabelText('Download failed')).toBeNull()
  })

  it('a file the caller may not see is absent, not marked', () => {
    // The distinction this pins: an unpermitted path never reaches the
    // manifest, so the tree has no row for it at all. Only a path we know
    // about but have not fetched gets a marker — the two must never look
    // alike, because one is "click to get it" and the other is "it is not
    // yours".
    render(<FileTreeItem {...props({ isNotDownloaded: false })} />)
    expect(screen.queryByLabelText('Not downloaded')).toBeNull()
  })
})

describe('FileTreeItem documents actions', () => {
  /** Radix renders menu content only once the menu is opened. */
  function openMenu() {
    fireEvent.contextMenu(screen.getByText('hr'))
  }

  it('offers "add files" when the caller supplies the handler', async () => {
    render(<FileTreeItem {...props({ onImportLocal: vi.fn() })} />)
    openMenu()
    expect(await screen.findByText('Add files…')).toBeTruthy()
  })

  it('does not offer it otherwise — 知识库 is written in the app, not imported into', async () => {
    render(<FileTreeItem {...props()} />)
    openMenu()
    // The menu is open (another item proves it), and this action is absent.
    expect(await screen.findByText('Add to Agent')).toBeTruthy()
    expect(screen.queryByText('Add files…')).toBeNull()
  })

  it('offers "Save to knowledge" on a 资料库 file when the caller supplies the handler', async () => {
    render(
      <FileTreeItem
        {...props({
          node: { name: '合同.pdf', path: '/vault/documents/hr/合同.pdf', type: 'file' },
          onSaveToKnowledge: vi.fn(),
        })}
      />,
    )
    fireEvent.contextMenu(screen.getByText('合同.pdf'))
    expect(await screen.findByText('整理到知识库')).toBeTruthy()
  })

  // A listed row has nothing on disk behind it. Delete, rename, reveal and the
  // rest would only fail — and "Delete" on a teammate's document reads as
  // deleting it for the team — so the menu keeps only what needs no local copy.
  it('offers only what needs no local copy on a row that is not downloaded', async () => {
    render(
      <FileTreeItem
        {...props({
          node: { name: '合同.pdf', path: '/vault/documents/hr/合同.pdf', type: 'file' },
          isNotDownloaded: true,
          onDownload: vi.fn(),
        })}
      />,
    )
    fireEvent.contextMenu(screen.getByText('合同.pdf'))
    expect(await screen.findByText('Download')).toBeTruthy()
    expect(screen.getByText('Copy Path')).toBeTruthy()
    for (const diskOnly of ['Delete', 'Rename', 'Duplicate', 'Reveal in Finder', 'Open with Default App', 'Add to Agent']) {
      expect(screen.queryByText(diskOnly), diskOnly).toBeNull()
    }
  })

  it('does not offer "Save to knowledge" on a directory, even if the handler is passed', async () => {
    render(<FileTreeItem {...props({ onSaveToKnowledge: vi.fn() })} />)
    openMenu()
    expect(await screen.findByText('Add to Agent')).toBeTruthy()
    expect(screen.queryByText('整理到知识库')).toBeNull()
  })
})

describe('FileTreeItem restriction marker', () => {
  it('marks a folder that has its own rule', () => {
    render(<FileTreeItem {...props({ isPermissionRestricted: true })} />)
    expect(screen.getByLabelText('Restricted to specific people')).toBeTruthy()
  })

  it('draws nothing when the folder has no rule of its own', () => {
    // Covers both a plain folder and one that merely sits under a restricted
    // parent: the caller passes false for each, and neither is marked.
    render(<FileTreeItem {...props({ isPermissionRestricted: false })} />)
    expect(screen.queryByLabelText('Restricted to specific people')).toBeNull()
  })

  it('draws nothing when the caller says nothing — the default is unmarked', () => {
    // This is the case for every member who cannot manage the team: they never
    // receive the rule list, so the flag is never set for them.
    render(<FileTreeItem {...props()} />)
    expect(screen.queryByLabelText('Restricted to specific people')).toBeNull()
  })
})
