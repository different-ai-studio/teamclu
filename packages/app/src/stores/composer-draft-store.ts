import { create } from "zustand";
import type { ComposerAttachment } from "@/lib/attachments/composer-attachment";

/** Composer with no session yet (new chat, actor preselect). */
export const UNBOUND_COMPOSER_KEY = "";

/** Stable empty list so selectors do not re-render while a session has no files. */
export const EMPTY_COMPOSER_FILES: ComposerAttachment[] = [];

export function composerDraftKey(sessionId: string | null | undefined): string {
  return sessionId ? sessionId : UNBOUND_COMPOSER_KEY;
}

interface ComposerDraftState {
  textByKey: Record<string, string>;
  filesByKey: Record<string, ComposerAttachment[]>;
  text: (key: string) => string;
  files: (key: string) => ComposerAttachment[];
  setText: (key: string, text: string) => void;
  setFiles: (key: string, files: ComposerAttachment[]) => void;
  updateFiles: (
    key: string,
    updater: (prev: ComposerAttachment[]) => ComposerAttachment[],
  ) => void;
  /**
   * Copy a draft onto another key and leave the source in place.
   * First-send switches the visible session before the composer clears, so the
   * source has to keep showing the text until `takeForSend` drops both keys.
   */
  copyOnto: (fromKey: string, toKey: string) => void;
  /**
   * Snapshot the session draft, then drop that key and `alsoClearKey`.
   * Restore goes back to `sessionId` only — the source key stays empty.
   */
  takeForSend: (
    sessionId: string,
    alsoClearKey?: string,
  ) => { text: string; files: ComposerAttachment[] };
  restore: (sessionId: string, text: string, files: ComposerAttachment[]) => void;
  clear: (key: string) => void;
  clearAll: () => void;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  textByKey: {},
  filesByKey: {},
  text: (key) => get().textByKey[key] ?? "",
  files: (key) => get().filesByKey[key] ?? EMPTY_COMPOSER_FILES,
  setText: (key, text) =>
    set((s) => {
      if (!text) {
        if (!(key in s.textByKey)) return s;
        return { textByKey: withoutKey(s.textByKey, key) };
      }
      if (s.textByKey[key] === text) return s;
      return { textByKey: { ...s.textByKey, [key]: text } };
    }),
  setFiles: (key, files) =>
    set((s) => {
      if (files.length === 0) {
        if (!(key in s.filesByKey)) return s;
        return { filesByKey: withoutKey(s.filesByKey, key) };
      }
      if (s.filesByKey[key] === files) return s;
      return { filesByKey: { ...s.filesByKey, [key]: files } };
    }),
  updateFiles: (key, updater) => {
    const prev = get().files(key);
    const next = updater(prev);
    if (next === prev) return;
    get().setFiles(key, next);
  },
  copyOnto: (fromKey, toKey) => {
    if (fromKey === toKey) return;
    set((s) => {
      const text = s.textByKey[fromKey];
      const files = s.filesByKey[fromKey];
      if (!text && !files?.length) return s;
      return {
        textByKey: text ? { ...s.textByKey, [toKey]: text } : s.textByKey,
        filesByKey: files?.length ? { ...s.filesByKey, [toKey]: files } : s.filesByKey,
      };
    });
  },
  takeForSend: (sessionId, alsoClearKey) => {
    const state = get();
    const text = state.textByKey[sessionId] ?? "";
    const files = state.filesByKey[sessionId] ?? EMPTY_COMPOSER_FILES;
    // The unbound key is "", so this must not use a truthiness check.
    const keys =
      alsoClearKey !== undefined && alsoClearKey !== sessionId
        ? [sessionId, alsoClearKey]
        : [sessionId];
    set((s) => {
      let textByKey = s.textByKey;
      let filesByKey = s.filesByKey;
      let changed = false;
      for (const key of keys) {
        if (key in textByKey) {
          textByKey = withoutKey(textByKey, key);
          changed = true;
        }
        if (key in filesByKey) {
          filesByKey = withoutKey(filesByKey, key);
          changed = true;
        }
      }
      return changed ? { textByKey, filesByKey } : s;
    });
    return { text, files };
  },
  restore: (sessionId, text, files) => {
    get().setText(sessionId, text);
    get().setFiles(sessionId, files);
  },
  clear: (key) =>
    set((s) => {
      if (!(key in s.textByKey) && !(key in s.filesByKey)) return s;
      return {
        textByKey: withoutKey(s.textByKey, key),
        filesByKey: withoutKey(s.filesByKey, key),
      };
    }),
  clearAll: () => set({ textByKey: {}, filesByKey: {} }),
}));
