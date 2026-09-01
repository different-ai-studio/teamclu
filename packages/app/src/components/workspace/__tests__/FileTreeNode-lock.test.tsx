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
