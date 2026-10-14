/**
 * Unit tests for file-tree-operations.ts
 *
 * Covers:
 *   - createNewFile / createNewFolder
 *   - renameItem
 *   - deleteItem (file + directory)
 *   - moveItem (same name guard)
 *   - copyItem (naming conflict: " copy", " copy N", recursive directory copy)
 *   - duplicateItem (delegates to copyItem in same directory)
 *   - readFileContent (text + binary fallback)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Tauri FS mock ──────────────────────────────────────────────────────────

const mockWriteTextFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRename = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockExists = vi.fn().mockResolvedValue(false);
const mockReadDir = vi.fn().mockRejectedValue(new Error('not a dir'));
const mockReadFile = vi.fn().mockResolvedValue(new Uint8Array([72, 105]));
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadTextFile = vi.fn().mockResolvedValue('file content');
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  remove: (...args: unknown[]) => mockRemove(...args),
  exists: (...args: unknown[]) => mockExists(...args),
  readDir: (...args: unknown[]) => mockReadDir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}));

import {
  createNewFile,
  createNewFolder,
  renameItem,
  deleteItem,
  moveItem,
  copyItem,
  duplicateItem,
  readFileContent,
} from '../file-tree-operations';

describe('file-tree-operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockResolvedValue(false);
    mockReadDir.mockRejectedValue(new Error('not a dir'));
    mockReadFile.mockResolvedValue(new Uint8Array([72, 105]));
    mockReadTextFile.mockResolvedValue('file content');
    mockInvoke.mockReset();
  });

  // ── createNewFile ────────────────────────────────────────────────────

  describe('createNewFile', () => {
    it('creates an empty text file at the given path', async () => {
      const result = await createNewFile('/workspace/src', 'hello.ts');
      expect(result).toBe(true);
      expect(mockWriteTextFile).toHaveBeenCalledWith('/workspace/src/hello.ts', '');
    });

    it('returns false on error', async () => {
      mockWriteTextFile.mockRejectedValueOnce(new Error('disk full'));
      const result = await createNewFile('/workspace', 'fail.ts');
      expect(result).toBe(false);
    });
  });

  // ── createNewFolder ──────────────────────────────────────────────────

  describe('createNewFolder', () => {
    it('creates a directory', async () => {
      const result = await createNewFolder('/workspace', 'new-dir');
      expect(result).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith('/workspace/new-dir');
    });

    it('returns false on error', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('permission denied'));
      const result = await createNewFolder('/workspace', 'fail-dir');
      expect(result).toBe(false);
    });
  });

  // ── renameItem ───────────────────────────────────────────────────────

  describe('renameItem', () => {
    it('renames file from old to new path', async () => {
      const result = await renameItem('/workspace/old.ts', '/workspace/new.ts');
      expect(result).toBe(true);
      expect(mockRename).toHaveBeenCalledWith('/workspace/old.ts', '/workspace/new.ts');
    });

    it('moves a file given a Windows path, keeping the file name only', async () => {
      const result = await moveItem('C:\\ws\\a.ts', 'C:\\ws\\sub');
      expect(result).toBe(true);
      expect(mockRename).toHaveBeenCalledWith('C:\\ws\\a.ts', 'C:\\ws\\sub\\a.ts');
    });

    it('treats a Windows path as the same destination whichever separator spells it', async () => {
      const result = await moveItem('C:\\ws\\sub\\a.ts', 'C:\\ws/sub');
      expect(result).toBe(false);
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns false on error', async () => {
      mockRename.mockRejectedValueOnce(new Error('conflict'));
      const result = await renameItem('/a', '/b');
      expect(result).toBe(false);
    });
  });

  // ── deleteItem ───────────────────────────────────────────────────────

  describe('deleteItem', () => {
    it('deletes a file (non-recursive)', async () => {
      const result = await deleteItem('/workspace/file.ts', false);
      expect(result).toBe(true);
      expect(mockRemove).toHaveBeenCalledWith('/workspace/file.ts', { recursive: false });
    });

    it('deletes a directory recursively', async () => {
      const result = await deleteItem('/workspace/dir', true);
      expect(result).toBe(true);
      expect(mockRemove).toHaveBeenCalledWith('/workspace/dir', { recursive: true });
    });

    it('returns false on error', async () => {
      mockRemove.mockRejectedValueOnce(new Error('busy'));
      const result = await deleteItem('/workspace/x', false);
      expect(result).toBe(false);
    });
  });

  // ── moveItem ─────────────────────────────────────────────────────────

  describe('moveItem', () => {
    it('moves file to target directory', async () => {
      const result = await moveItem('/workspace/a.ts', '/workspace/sub');
      expect(result).toBe(true);
      expect(mockRename).toHaveBeenCalledWith('/workspace/a.ts', '/workspace/sub/a.ts');
    });

    it('returns false when source and destination are the same', async () => {
      const result = await moveItem('/workspace/sub/a.ts', '/workspace/sub');
      expect(result).toBe(false);
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns false on error', async () => {
      mockRename.mockRejectedValueOnce(new Error('conflict'));
      const result = await moveItem('/workspace/a.ts', '/workspace/other');
      expect(result).toBe(false);
    });
  });

  // ── copyItem ─────────────────────────────────────────────────────────

  describe('copyItem', () => {
    it('copies a file to target directory', async () => {
      // File: readDir throws, so it falls through to readFile + writeFile
      const result = await copyItem('/workspace/hello.ts', '/workspace/dest');
      expect(result).toBe(true);
      expect(mockReadFile).toHaveBeenCalledWith('/workspace/hello.ts');
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/workspace/dest/hello.ts',
        expect.any(Uint8Array),
      );
    });

    it('copies a file picked with a Windows path under its own name, not the whole path', async () => {
      // The Tauri file dialog hands back `C:\\…` paths. Taking the name with
      // lastIndexOf('/') used the entire path as the name, so the destination
      // held a colon and the write failed ("1 item could not be added").
      const result = await copyItem(
        'C:\\Users\\me\\Downloads\\报告.pdf',
        'C:\\Users\\me\\TeamClu\\资料库',
      );
      expect(result).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        'C:\\Users\\me\\TeamClu\\资料库\\报告.pdf',
        expect.any(Uint8Array),
      );
    });

    it('copies a Windows directory recursively with Windows child paths', async () => {
      mockReadDir
        .mockResolvedValueOnce([{ name: 'a.txt' }])
        .mockRejectedValueOnce(new Error('not a dir'));
      const result = await copyItem('C:\\src\\folder', 'C:\\dest');
      expect(result).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith('C:\\dest\\folder');
      expect(mockReadFile).toHaveBeenCalledWith('C:\\src\\folder\\a.txt');
      expect(mockWriteFile).toHaveBeenCalledWith(
        'C:\\dest\\folder\\a.txt',
        expect.any(Uint8Array),
      );
    });

    it('appends " copy" when destination already exists', async () => {
      // First exists check (dest/hello.ts) → true, second (dest/hello copy.ts) → false
      mockExists
        .mockResolvedValueOnce(true)   // /workspace/dest/hello.ts exists
        .mockResolvedValueOnce(false); // /workspace/dest/hello copy.ts does NOT exist

      const result = await copyItem('/workspace/hello.ts', '/workspace/dest');
      expect(result).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/workspace/dest/hello copy.ts',
        expect.any(Uint8Array),
      );
    });

    it('appends " copy N" when " copy" also exists', async () => {
      mockExists
        .mockResolvedValueOnce(true)   // hello.ts exists
        .mockResolvedValueOnce(true)   // hello copy.ts exists
        .mockResolvedValueOnce(false); // hello copy 2.ts does NOT exist

      const result = await copyItem('/workspace/hello.ts', '/workspace/dest');
      expect(result).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/workspace/dest/hello copy 2.ts',
        expect.any(Uint8Array),
      );
    });

    it('handles files without extension', async () => {
      mockExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const result = await copyItem('/workspace/Makefile', '/workspace/dest');
      expect(result).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/workspace/dest/Makefile copy',
        expect.any(Uint8Array),
      );
    });

    it('recursively copies a directory', async () => {
      // readDir succeeds for the source → it's a directory
      mockReadDir.mockResolvedValueOnce([
        { name: 'a.ts', isFile: true, isDirectory: false },
        { name: 'b.ts', isFile: true, isDirectory: false },
      ]);
      // Sub-items are files (readDir fails for them)
      mockReadDir.mockRejectedValueOnce(new Error('not a dir'));
      mockReadDir.mockRejectedValueOnce(new Error('not a dir'));

      const result = await copyItem('/workspace/src', '/workspace/dest');
      expect(result).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith('/workspace/dest/src');
      expect(mockReadFile).toHaveBeenCalledTimes(2);
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it('returns false on read error', async () => {
      mockReadDir.mockRejectedValueOnce(new Error('not a dir'));
      mockReadFile.mockRejectedValueOnce(new Error('read fail'));

      const result = await copyItem('/workspace/bad.ts', '/workspace/dest');
      expect(result).toBe(false);
    });
  });

  // ── duplicateItem ────────────────────────────────────────────────────

  describe('duplicateItem', () => {
    it('copies a file into its own parent directory', async () => {
      // The file itself exists at the original location, but "copy" doesn't yet
      const result = await duplicateItem('/workspace/hello.ts');
      expect(result).toBe(true);
      // copyItem is called with the same parent directory
      // Since mockExists returns false, dest = /workspace/hello.ts (but copyItem
      // internally handles the naming via exists check)
    });

    it('duplicates a Windows file next to the original with a " copy" suffix', async () => {
      mockExists
        .mockResolvedValueOnce(true)   // C:\\ws\\hello.ts is already there
        .mockResolvedValueOnce(false); // C:\\ws\\hello copy.ts is free
      const result = await duplicateItem('C:\\ws\\hello.ts');
      expect(result).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith('C:\\ws\\hello copy.ts', expect.any(Uint8Array));
    });

    it('returns false when copy fails', async () => {
      mockReadDir.mockRejectedValueOnce(new Error('not a dir'));
      mockReadFile.mockRejectedValueOnce(new Error('read fail'));

      const result = await duplicateItem('/workspace/bad.ts');
      expect(result).toBe(false);
    });
  });

  // ── readFileContent ──────────────────────────────────────────────────

  describe('readFileContent', () => {
    it('reads text file content', async () => {
      const content = await readFileContent('/workspace', '/workspace/hello.ts');
      expect(content).toBe('file content');
      expect(mockReadTextFile).toHaveBeenCalledWith('/workspace/hello.ts');
    });

    it('returns undefined for binary/unreadable files', async () => {
      mockReadTextFile.mockRejectedValueOnce(new Error('binary'));
      const content = await readFileContent('/workspace', '/workspace/image.png');
      expect(content).toBeUndefined();
    });

    it('falls back to backend workspace reader when fs scope rejects the path', async () => {
      mockReadTextFile.mockRejectedValueOnce(
        new Error('forbidden path: /Users/weigan.huang/ws/ac360-team'),
      );
      mockInvoke.mockResolvedValueOnce('linked file content');

      const content = await readFileContent('/workspace', '/workspace/ac360-link/README.md');

      expect(mockInvoke).toHaveBeenCalledWith('read_workspace_text_file', {
        workspacePath: '/workspace',
        path: '/workspace/ac360-link/README.md',
      });
      expect(content).toBe('linked file content');
    });
  });
});
