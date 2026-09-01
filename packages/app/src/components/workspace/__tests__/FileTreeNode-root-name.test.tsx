/**
 * The two fixed roots read as 资料库 / 知识库 while staying `documents` and
 * `knowledge` on disk.
 *
 * The case worth a test is the compacted one. When a root holds a single
 * expanded child the tree collapses the chain into one row and draws a joined
 * path — and the node backing that row is the END of the chain, not the root.
 * A translation that asks "is this node a root?" therefore finds nothing and
 * the row renders as `documents/new-folder`, which is what shipped and had to
 * be fixed.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    node: { name: 'documents', path: '/vault/team-sync/documents', type: 'directory' },
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

describe('FileTreeItem root naming', () => {
  it('draws the localized name in place of the on-disk one', () => {
    render(<FileTreeItem {...props({ localizedName: '资料库' })} />)
    expect(screen.getByText('资料库')).toBeTruthy()
    expect(screen.queryByText('documents')).toBeNull()
  })

  it('a localized name wins over the compacted path', () => {
    // What the compacted row must look like: the root translated, the rest of
    // the chain untouched.
    render(
      <FileTreeItem
        {...props({ compactName: 'documents/new-folder', localizedName: '资料库/new-folder' })}
      />,
    )
    expect(screen.getByText('资料库/new-folder')).toBeTruthy()
    expect(screen.queryByText('documents/new-folder')).toBeNull()
  })

  it('falls back to the compacted path when nothing is localized', () => {
    // A chain deeper in the tree keeps every segment as it is on disk.
    render(<FileTreeItem {...props({ compactName: 'notes/2026/q3' })} />)
    expect(screen.getByText('notes/2026/q3')).toBeTruthy()
  })

  it('an ordinary folder keeps its own name', () => {
    render(<FileTreeItem {...props({ node: { name: 'knowledge', path: '/ws/a/knowledge', type: 'directory' } as never })} />)
    expect(screen.getByText('knowledge')).toBeTruthy()
  })
})
