import { basenameOf, dirnameOf, isSamePath, joinPathLike } from '@/lib/fs-path';
import { isTauri } from '@/lib/utils';

// File operation helpers
export async function createNewFile(
  dirPath: string,
  fileName: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const fullPath = joinPathLike(dirPath, fileName);
    await writeTextFile(fullPath, "");
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to create file:", error);
    return false;
  }
}

export async function createNewFolder(
  dirPath: string,
  folderName: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    const fullPath = joinPathLike(dirPath, folderName);
    await mkdir(fullPath);
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to create folder:", error);
    return false;
  }
}

export async function renameItem(oldPath: string, newPath: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { rename } = await import("@tauri-apps/plugin-fs");
    await rename(oldPath, newPath);
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to rename:", error);
    return false;
  }
}

export async function deleteItem(
  path: string,
  isDirectory: boolean,
  _workspacePath?: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    await remove(path, { recursive: isDirectory });
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to delete:", error);
    return false;
  }
}

export async function revealInFinder(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_in_folder", { path });
  } catch {
    // Fallback: try shell open on the parent directory
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(dirnameOf(path));
    } catch (error) {
      console.error("[FileTree] Failed to reveal in finder:", error);
    }
  }
}

export async function openWithDefaultApp(path: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_with_default_app", { path });
  } catch (error) {
    console.error("[FileTree] Failed to open with default app:", error);
  }
}

export async function openInTerminal(dirPath: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_in_terminal", { path: dirPath });
  } catch (error) {
    console.error("[FileTree] Failed to open terminal:", error);
  }
}

export async function moveItem(fromPath: string, toDir: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { rename } = await import("@tauri-apps/plugin-fs");
    const fileName = basenameOf(fromPath);
    const newPath = joinPathLike(toDir, fileName);
    if (isSamePath(fromPath, newPath)) return false;
    await rename(fromPath, newPath);
    return true;
  } catch (error) {
    console.error("[FileTree] Failed to move item:", error);
    return false;
  }
}

/** Recursively copy a file or directory to a target directory */
export async function copyItem(sourcePath: string, targetDir: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { exists, readDir, readFile, writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
    // The name comes from the last segment under either separator: the file
    // dialog hands back `C:\…` on Windows, and cutting at `/` alone used the
    // whole path as the name, so the write failed on the colon.
    const name = basenameOf(sourcePath);
    let destPath = joinPathLike(targetDir, name);

    // Handle naming conflict: append " copy" or " copy N"
    if (await exists(destPath)) {
      const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
      const base = ext ? name.slice(0, -ext.length) : name;
      let suffix = 1;
      destPath = joinPathLike(targetDir, `${base} copy${ext}`);
      while (await exists(destPath)) {
        suffix++;
        destPath = joinPathLike(targetDir, `${base} copy ${suffix}${ext}`);
      }
    }

    // Check if source is a directory
    try {
      const entries = await readDir(sourcePath);
      // It's a directory — create it and copy contents recursively
      await mkdir(destPath);
      for (const entry of entries) {
        const childPath = joinPathLike(sourcePath, entry.name);
        const success = await copyItem(childPath, destPath);
        if (!success) return false;
      }
      return true;
    } catch {
      // Not a directory — it's a file, copy bytes
      const bytes = await readFile(sourcePath);
      await writeFile(destPath, bytes);
      return true;
    }
  } catch (error) {
    console.error("[FileTree] Failed to copy item:", error);
    return false;
  }
}

/** Copy files from external paths (e.g. Finder drag-drop) into a target directory */
export async function copyExternalFiles(sourcePaths: string[], targetDir: string): Promise<boolean> {
  if (!isTauri() || sourcePaths.length === 0) return false;
  try {
    let allSuccess = true;
    for (const sourcePath of sourcePaths) {
      const success = await copyItem(sourcePath, targetDir);
      if (!success) allSuccess = false;
    }
    return allSuccess;
  } catch (error) {
    console.error("[FileTree] Failed to copy external files:", error);
    return false;
  }
}

/** Duplicate a file or folder in the same directory (appends " copy" / " copy N") */
export async function duplicateItem(sourcePath: string): Promise<boolean> {
  if (!isTauri()) return false;
  return copyItem(sourcePath, dirnameOf(sourcePath));
}

function isFsScopeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('forbidden path:');
}

/** Read file content for undo backup (text files only) */
export async function readFileContent(
  workspacePath: string,
  path: string,
): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(path);
  } catch (error) {
    if (!isFsScopeError(error)) {
      return undefined; // Binary or unreadable
    }

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("read_workspace_text_file", { workspacePath, path });
    } catch {
      return undefined;
    }
  }
}
