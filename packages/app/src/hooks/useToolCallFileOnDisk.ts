import { useEffect, useState } from "react";
import { isTauri } from "@/lib/utils";

/** Resolve a tool file argument to an absolute path when possible. */
export function resolveWorkspaceRelativePath(
  filePath: string | null | undefined,
  workspacePath: string | null,
): string | null {
  if (!filePath?.trim()) return null;
  if (filePath.startsWith("/")) return filePath;
  if (!workspacePath) return null;
  return `${workspacePath}/${filePath}`;
}

/**
 * Tracks whether a path exists on disk (Tauri only).
 * When shouldVerify is false, or on web, always returns null (unknown — keep prior UX).
 * null = not applicable or check pending / inconclusive; false = confirmed missing; true = exists.
 */
export function useToolCallFileOnDisk(
  absolutePath: string | null,
  shouldVerify: boolean,
): boolean | null {
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    if (!shouldVerify || !absolutePath) {
      setExists(null);
      return;
    }
    if (!isTauri()) {
      setExists(null);
      return;
    }

    let cancelled = false;

    const check = async () => {
      try {
        const { exists: fsExists } = await import("@tauri-apps/plugin-fs");
        const ok = await fsExists(absolutePath);
        if (!cancelled) setExists(ok);
      } catch {
        if (!cancelled) setExists(null);
      }
    };

    void check();

    const unlistenRef: { fn?: () => void } = {};
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u = await listen<{ paths: string[]; directories: string[] }>(
          "file-change-batch",
          (event) => {
            const touched = event.payload.paths.some(
              (p) =>
                p === absolutePath ||
                absolutePath.startsWith(`${p}/`) ||
                p.startsWith(`${absolutePath}/`),
            );
            if (touched) void check();
          },
        );
        if (!cancelled) unlistenRef.fn = u;
        else u();
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
      unlistenRef.fn?.();
    };
  }, [shouldVerify, absolutePath]);

  return exists;
}
