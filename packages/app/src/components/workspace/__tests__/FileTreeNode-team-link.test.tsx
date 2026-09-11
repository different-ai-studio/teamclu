/**
 * The workspace's links to the team's synced roots are marked as links, at the
 * workspace root only.
 *
 * `team-knowledge` used to carry an Obsidian mark and `team-documents` nothing,
 * which said what might open the folder rather than what it is: a pointer into
 * the team's shared tree, where an edit is everyone's edit.
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

describe('FileTreeItem team links', () => {
  it.each(['team-documents', 'team-knowledge'])('marks %s at the workspace root as a link', (name) => {
    render(<FileTreeItem {...props({ node: { name, path: `/ws/${name}`, type: 'directory' }, level: 0 })} />)
    expect(screen.getByTestId('file-tree-team-link-icon')).toBeTruthy()
  })

  it('does not mark a nested folder that happens to share the name', () => {
    render(
      <FileTreeItem
        {...props({ node: { name: 'team-knowledge', path: '/ws/src/team-knowledge', type: 'directory' }, level: 1 })}
      />,
    )
    expect(screen.queryByTestId('file-tree-team-link-icon')).toBeNull()
  })

  it('does not mark a file, or a link sitting in the trash', () => {
    const { unmount } = render(
      <FileTreeItem {...props({ node: { name: 'team-knowledge', path: '/ws/team-knowledge', type: 'file' }, level: 0 })} />,
    )
    expect(screen.queryByTestId('file-tree-team-link-icon')).toBeNull()
    unmount()
    render(
      <FileTreeItem
        {...props({ node: { name: 'team-documents', path: '/ws/.trash/team-documents', type: 'directory' }, level: 0 })}
      />,
    )
    expect(screen.queryByTestId('file-tree-team-link-icon')).toBeNull()
  })

  it('no longer marks teamclu-team — not as a link, and not with the logo', () => {
    // The daemon no longer creates it; the only `teamclu-team` a tree can still
    // show is a real directory from a very old layout, and that is just a
    // folder. It used to carry the app logo at the workspace root.
    const { container } = render(
      <FileTreeItem {...props({ node: { name: 'teamclu-team', path: '/ws/teamclu-team', type: 'directory' }, level: 0 })} />,
    )
    expect(screen.queryByTestId('file-tree-team-link-icon')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})
