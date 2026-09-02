/**
 * useAutoSave — Hook for debounced auto-save with self-write detection.
 *
 * Automatically writes editor content to disk after 1s of idle.
 * Uses content hashing to distinguish self-writes from agent writes
 * in file-change events.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** Save status for the status indicator */
type SaveStatus = "saved" | "modified" | "saving";

/** Hash content using SHA-256 (Web Crypto API) */
async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Auto-save debounce delay in milliseconds */
const AUTOSAVE_DELAY = 1000;

interface UseAutoSaveOptions {
  filePath: string;
  content: string;
  isModified: boolean;
  enabled?: boolean;
}

interface UseAutoSaveResult {
  saveStatus: SaveStatus;
  /** Check if a file-change event is from our own auto-save */
  isSelfWrite: (fileContent: string) => Promise<boolean>;
  /** Force a save now (for close handlers) */
  saveNow: () => Promise<void>;
  /** Cancel any pending auto-save (call when external change is applied) */
  cancelPendingSave: () => void;
}

export function useAutoSave({
  filePath,
  content,
  isModified,
  enabled = true,
}: UseAutoSaveOptions): UseAutoSaveResult {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const pendingSaveHashRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const filePathRef = useRef(filePath);
  contentRef.current = content;
  filePathRef.current = filePath;

  // When cancelPendingSave is called (external change arriving), we suppress
  // the NEXT auto-save scheduling. Without this, the isModified tracking effect
  // sets isModified=true momentarily (because currentContent != new content prop),
  // which re-triggers the auto-save effect to save OLD content — overwriting the
  // agent's change. The suppress flag prevents this one-time re-arming.
  const suppressNextRef = useRef(false);

  // Perform the actual save
  const doSave = useCallback(async (contentToSave: string, path: string) => {
    // Check if running in Tauri
    if (
      typeof window === "undefined" ||
      !(window as unknown as { __TAURI__: unknown }).__TAURI__
    ) {
      return; // Can't save in web mode
    }

    setSaveStatus("saving");

    try {
      // Compute hash before writing so we can detect self-writes
      const hash = await hashContent(contentToSave);
      pendingSaveHashRef.current = hash;

      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, contentToSave);

      setSaveStatus("saved");
    } catch (error) {
      console.error("Auto-save failed:", error);
      toast.error(`Auto-save failed: ${error}`);
      setSaveStatus("modified");
      // Clear the pending hash on error
      pendingSaveHashRef.current = null;
    }
  }, []);

  // Debounced auto-save effect
  useEffect(() => {
    if (!enabled || !isModified) return;

    // If suppressed (external change being processed), reset flag and skip.
    // The external handler will update currentContent, which will re-run this
    // effect with isModified=false, naturally preventing the stale save.
    if (suppressNextRef.current) {
      suppressNextRef.current = false;
      return;
    }

    // Mark as modified when new content comes in and we schedule a save
    setSaveStatus("modified");

    // Clear existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Set new debounce timer
    timerRef.current = setTimeout(() => {
      doSave(contentRef.current, filePathRef.current);
    }, AUTOSAVE_DELAY);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [content, isModified, enabled, doSave]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Check if a file-change content matches our pending save
  const isSelfWrite = useCallback(async (fileContent: string): Promise<boolean> => {
    if (!pendingSaveHashRef.current) return false;

    const hash = await hashContent(fileContent);
    if (hash === pendingSaveHashRef.current) {
      pendingSaveHashRef.current = null; // Clear after match
      return true;
    }
    return false;
  }, []);

  // Cancel any pending auto-save and suppress the next scheduling.
  // Called when an external file change is detected (agent write, etc.)
  // to prevent auto-save from overwriting the incoming content.
  const cancelPendingSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    suppressNextRef.current = true;
  }, []);

  // Force save now (for close handlers, etc.)
  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    suppressNextRef.current = false;
    await doSave(contentRef.current, filePathRef.current);
  }, [doSave]);

  return { saveStatus, isSelfWrite, saveNow, cancelPendingSave };
}
