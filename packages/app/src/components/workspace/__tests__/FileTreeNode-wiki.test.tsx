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
    node: { name: 'wiki', path: '/vault/knowledge/wiki', type: 'directory' },
    level: 1,
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

describe('FileTreeItem LLM wiki', () => {
  it('marks agent-owned wiki rows', () => {
    render(<FileTreeItem {...props({ agentOwned: true })} />)
    expect(screen.getByLabelText('AI-managed')).toBeTruthy()
  })
})
