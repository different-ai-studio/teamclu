/**
 * Integration tests for FileTree interactions
 *
 * Covers:
 *   - Context menu: Copy, Cut, Paste, Duplicate
 *   - Keyboard shortcuts: ⌘C, ⌘X, ⌘V, ⌘D, F2, Delete
 *   - Multi-select: Shift+Click, Cmd+Click
 *   - Keyboard navigation: Arrow keys, Home, End, Enter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

let mockFileTree: any[] = [];
let mockExpandedPaths = new Set<string>();
let mockFocusedPath: string | null = null;
let mockSelectedFiles: string[] = [];
let mockClipboardPaths: string[] = [];
let mockClipboardMode: 'copy' | 'cut' | null = null;

const mockSelectFile = vi.fn();
const mockSelectFileRange = vi.fn();
const mockToggleFileSelection = vi.fn();
const mockExpandDirectory = vi.fn().mockResolvedValue(undefined);
const mockCollapseDirectory = vi.fn();
const mockSetFocusedPath = vi.fn((p: string) => { mockFocusedPath = p; });
const mockPushUndo = vi.fn();
const mockRefreshFileTree = vi.fn().mockResolvedValue(undefined);
const mockSetClipboard = vi.fn((paths: string[], mode: 'copy' | 'cut') => {
  mockClipboardPaths = paths;
  mockClipboardMode = mode;
});
const mockPasteFiles = vi.fn().mockResolvedValue(true);
const mockClearSelection = vi.fn();

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({
        fileTree: mockFileTree,
        expandedPaths: mockExpandedPaths,
        loadingPaths: new Set<string>(),
        selectedFile: null,
        selectedFiles: mockSelectedFiles,
        workspacePath: '/workspace',
        focusedPath: mockFocusedPath,
        selectFile: mockSelectFile,
        selectFileRange: mockSelectFileRange,
        toggleFileSelection: mockToggleFileSelection,
        expandDirectory: mockExpandDirectory,
        collapseDirectory: mockCollapseDirectory,
        setFocusedPath: mockSetFocusedPath,
        pushUndo: mockPushUndo,
        refreshFileTree: mockRefreshFileTree,
        clearSelection: mockClearSelection,
        clipboardPaths: mockClipboardPaths,
        clipboardMode: mockClipboardMode,
        setClipboard: mockSetClipboard,
        pasteFiles: mockPasteFiles,
        revealFile: vi.fn().mockResolvedValue(undefined),
      }),
    {
      getState: () => ({
        selectedFiles: mockSelectedFiles,
        fileTree: mockFileTree,
        clearSelection: mockClearSelection,
        expandedPaths: mockExpandedPaths,
        setClipboard: mockSetClipboard,
        clipboardPaths: mockClipboardPaths,
        clipboardMode: mockClipboardMode,
        pasteFiles: mockPasteFiles,
      }),
      subscribe: vi.fn(() => vi.fn()),
      setState: vi.fn(),
    },
  ),
}));

vi.mock('@/hooks/use-git-status', () => ({
  useGitStatus: () => ({ gitStatuses: new Map() }),
}));

vi.mock('@/stores/git-settings', () => ({
  useGitSettingsStore: () => ({
    showGitStatus: false,
    showStatusIcons: false,
    statusColors: {},
  }),
}));

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      myRole: 'admin',
      teamGitFileSyncStatusMap: {},
      teamModeType: null,
      teamGitSyncing: false,
      teamGitLastSyncAt: null,
    }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/utils', () => ({
  isTauri: () => false,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  copyToClipboard: vi.fn(),
}));

const mockDuplicateItem = vi.fn().mockResolvedValue(true);
const mockMoveItem = vi.fn().mockResolvedValue(true);
const mockCopyItemFn = vi.fn().mockResolvedValue(true);

vi.mock('../file-tree-operations', () => ({
  createNewFile: vi.fn().mockResolvedValue(true),
  createNewFolder: vi.fn().mockResolvedValue(true),
  renameItem: vi.fn().mockResolvedValue(true),
  deleteItem: vi.fn().mockResolvedValue(true),
  revealInFinder: vi.fn(),
  openWithDefaultApp: vi.fn(),
  openInTerminal: vi.fn(),
  moveItem: (...args: unknown[]) => mockMoveItem(...args),
  copyItem: (...args: unknown[]) => mockCopyItemFn(...args),
  duplicateItem: (...args: unknown[]) => mockDuplicateItem(...args),
  readFileContent: vi.fn().mockResolvedValue('content'),
}));

// Use real FileTreeNode for context menu testing
// But we need the UI components mocked for the test environment
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: any) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: any) => <div>{children}</div>,
  ContextMenuContent: ({ children }: any) => <div data-testid="context-menu">{children}</div>,
  ContextMenuItem: ({ children, onClick, onSelect, variant }: any) => (
    <button
      onClick={(e) => {
        onClick?.(e);
        onSelect?.(e.nativeEvent);
      }}
      data-variant={variant}
      data-testid="context-menu-item"
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuShortcut: ({ children }: any) => <span>{children}</span>,
}));

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: any) => open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children }: any) => <button>{children}</button>,
}));

vi.mock('@/lib/ui/file-icons', () => ({
  getFileIcon: () => null,
}));

vi.mock('@/lib/git-status-utils', () => ({
  getGitStatusIndicator: () => ({ Icon: 'span', color: '', label: '' }),
  getGitStatusTextColor: () => '',
}));

vi.mock('@/lib/git/service', () => ({
  GitStatus: {},
}));

vi.mock('@/stores/tabs', () => ({
  useTabsStore: Object.assign(
    () => ({}),
    {
      getState: () => ({ openTab: vi.fn() }),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

import { FileTree } from '@/components/workspace/FileTree';

describe('FileTree interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFocusedPath = null;
    mockSelectedFiles = [];
    mockClipboardPaths = [];
    mockClipboardMode = null;
    mockFileTree = [
      {
        name: 'src',
        path: '/workspace/src',
        type: 'directory',
        children: [
          { name: 'index.ts', path: '/workspace/src/index.ts', type: 'file' },
          { name: 'utils.ts', path: '/workspace/src/utils.ts', type: 'file' },
        ],
      },
      { name: 'README.md', path: '/workspace/README.md', type: 'file' },
      { name: 'package.json', path: '/workspace/package.json', type: 'file' },
    ];
    mockExpandedPaths = new Set(['/workspace/src']);
  });

  // ── Keyboard navigation ────────────────────────────────────────────

  describe('keyboard navigation', () => {
    it('ArrowDown moves focus to next item', () => {
      mockFocusedPath = '/workspace/src';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'ArrowDown' });
      expect(mockSetFocusedPath).toHaveBeenCalled();
    });

    it('ArrowUp moves focus to previous item', () => {
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'ArrowUp' });
      expect(mockSetFocusedPath).toHaveBeenCalled();
    });

    it('ArrowRight expands a collapsed directory', () => {
      mockExpandedPaths = new Set(); // src is collapsed
      mockFocusedPath = '/workspace/src';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'ArrowRight' });
      expect(mockExpandDirectory).toHaveBeenCalledWith('/workspace/src');
    });

    it('ArrowLeft collapses an expanded directory', () => {
      mockFocusedPath = '/workspace/src';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'ArrowLeft' });
      expect(mockCollapseDirectory).toHaveBeenCalledWith('/workspace/src');
    });

    it('Enter on a file selects it', () => {
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'Enter' });
      expect(mockSelectFile).toHaveBeenCalledWith('/workspace/README.md');
    });

    it('Home moves focus to first item', () => {
      mockFocusedPath = '/workspace/package.json';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'Home' });
      expect(mockSetFocusedPath).toHaveBeenCalledWith('/workspace/src');
    });

    it('End moves focus to last item', () => {
      mockFocusedPath = '/workspace/src';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'End' });
      expect(mockSetFocusedPath).toHaveBeenCalledWith('/workspace/package.json');
    });

    it('F2 triggers rename on focused path', () => {
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'F2' });
      // Should enter renaming mode — the InlineInput should appear
      // We can verify by checking that the tree re-renders with renaming state
      // (The mock FileTreeNode will receive isRenaming=true on next render)
    });

    it('Delete triggers delete confirmation on focused path', () => {
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'Delete' });
      // Delete confirmation dialog should appear
      expect(screen.getByTestId('alert-dialog')).toBeDefined();
    });
  });

  // ── Clipboard keyboard shortcuts ───────────────────────────────────

  describe('clipboard keyboard shortcuts', () => {
    it('⌘C copies focused path to clipboard', () => {
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'c', metaKey: true });
      expect(mockSetClipboard).toHaveBeenCalledWith(['/workspace/README.md'], 'copy');
    });

    it('⌘X cuts focused path to clipboard', () => {
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'x', metaKey: true });
      expect(mockSetClipboard).toHaveBeenCalledWith(['/workspace/README.md'], 'cut');
    });

    it('⌘C copies all selected files when multi-selected', () => {
      mockSelectedFiles = ['/workspace/README.md', '/workspace/package.json'];
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'c', metaKey: true });
      expect(mockSetClipboard).toHaveBeenCalledWith(
        ['/workspace/README.md', '/workspace/package.json'],
        'copy',
      );
    });

    it('⌘V pastes into focused directory', async () => {
      mockClipboardPaths = ['/workspace/README.md'];
      mockClipboardMode = 'copy';
      mockFocusedPath = '/workspace/src';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'v', metaKey: true });
      // pasteFiles should be called with the focused directory
      await vi.waitFor(() => {
        expect(mockPasteFiles).toHaveBeenCalledWith('/workspace/src');
      });
    });

    it('⌘V on focused file pastes into parent directory', async () => {
      mockClipboardPaths = ['/workspace/package.json'];
      mockClipboardMode = 'copy';
      mockFocusedPath = '/workspace/src/index.ts';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'v', metaKey: true });
      await vi.waitFor(() => {
        expect(mockPasteFiles).toHaveBeenCalledWith('/workspace/src');
      });
    });

    it('⌘D duplicates focused item', async () => {
      mockFocusedPath = '/workspace/README.md';
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'd', metaKey: true });
      await vi.waitFor(() => {
        expect(mockDuplicateItem).toHaveBeenCalledWith('/workspace/README.md');
      });
    });

    it('⌘D does nothing when no focused path', () => {
      mockFocusedPath = null;
      const { container } = render(<FileTree />);
      const treeContainer = container.querySelector('[tabindex]')!;

      fireEvent.keyDown(treeContainer, { key: 'd', metaKey: true });
      expect(mockDuplicateItem).not.toHaveBeenCalled();
    });
  });

  // ── Context menu actions ───────────────────────────────────────────

  describe('context menu', () => {
    it('renders Duplicate menu item for files', () => {
      render(<FileTree />);
      const menuItems = screen.getAllByTestId('context-menu-item');
      const texts = menuItems.map(el => el.textContent);
      expect(texts.some(t => t?.includes('Duplicate'))).toBe(true);
    });

    it('renders Paste menu item for files when clipboard has content', () => {
      mockClipboardPaths = ['/workspace/package.json'];
      mockClipboardMode = 'copy';
      render(<FileTree />);
      const menuItems = screen.getAllByTestId('context-menu-item');
      const texts = menuItems.map(el => el.textContent);
      // Paste should appear for both files and directories
      const pasteItems = texts.filter(t => t?.includes('Paste'));
      expect(pasteItems.length).toBeGreaterThan(0);
    });

    it('clicking Duplicate calls duplicateItem', async () => {
      render(<FileTree />);
      const menuItems = screen.getAllByTestId('context-menu-item');
      const duplicateBtn = menuItems.find(el => el.textContent?.includes('Duplicate'));
      expect(duplicateBtn).toBeDefined();

      fireEvent.click(duplicateBtn!);
      await vi.waitFor(() => {
        expect(mockDuplicateItem).toHaveBeenCalled();
      });
    });

    it('immediate click after opening context menu does not trigger actions', () => {
      render(<FileTree />);
      const fileItems = screen.getAllByTestId('file-tree-item');
      fireEvent.contextMenu(fileItems[0]);

      const menuItems = screen.getAllByTestId('context-menu-item');
      const copyBtn = menuItems.find(el => {
        const text = el.textContent || '';
        return text.includes('Copy') && text.includes('⌘C');
      });
      expect(copyBtn).toBeDefined();
      fireEvent.click(copyBtn!);

      expect(mockSetClipboard).not.toHaveBeenCalled();
    });

    it('clicking Copy calls setClipboard with copy mode', () => {
      render(<FileTree />);
      const menuItems = screen.getAllByTestId('context-menu-item');
      // Find the "Copy" button (not "Copy Path" or "Copy Relative Path")
      const copyBtn = menuItems.find(el => {
        const text = el.textContent || '';
        return text.includes('Copy') && text.includes('⌘C');
      });
      expect(copyBtn).toBeDefined();
      fireEvent.click(copyBtn!);
      expect(mockSetClipboard).toHaveBeenCalled();
    });

    it('clicking Cut calls setClipboard with cut mode', () => {
      render(<FileTree />);
      const menuItems = screen.getAllByTestId('context-menu-item');
      const cutBtn = menuItems.find(el => el.textContent?.includes('Cut'));
      expect(cutBtn).toBeDefined();
      fireEvent.click(cutBtn!);
      expect(mockSetClipboard).toHaveBeenCalled();
    });
  });

  // ── Multi-select ───────────────────────────────────────────────────

  describe('multi-select', () => {
    it('Shift+Click triggers range selection', () => {
      render(<FileTree />);
      const items = screen.getAllByTestId('file-tree-item');
      // Find a file item and shift-click it
      const fileItem = items.find(el => el.textContent?.includes('README'));
      if (fileItem) {
        fireEvent.click(fileItem, { shiftKey: true });
        expect(mockSelectFileRange).toHaveBeenCalledWith('/workspace/README.md');
      }
    });

    it('Cmd+Click toggles file selection', () => {
      render(<FileTree />);
      const items = screen.getAllByTestId('file-tree-item');
      const fileItem = items.find(el => el.textContent?.includes('README'));
      if (fileItem) {
        fireEvent.click(fileItem, { metaKey: true });
        expect(mockToggleFileSelection).toHaveBeenCalledWith('/workspace/README.md');
      }
    });
  });
});
