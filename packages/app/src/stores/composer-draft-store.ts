import { create } from "zustand";
import type { ComposerAttachment } from "@/lib/attachments/composer-attachment";

/** Composer with no session yet (new chat, actor preselect). */
export const UNBOUND_COMPOSER_KEY = "";

/** Text and local file paths. Picked file bytes are not stored. */
export const COMPOSER_DRAFT_STORAGE_KEY = "teamclu-composer-drafts";

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
  /** Replace memory with the snapshot saved for the next launch. */
  loadPersisted: () => void;
}

interface PersistedCloudPath {
  kind: "cloud";
  name: string;
  size: number;
  path: string;
  type: string;
}

type PersistedFileEntry =
  | Extract<ComposerAttachment, { kind: "local" }>
  | PersistedCloudPath;

interface PersistedComposerDraft {
  textByKey: Record<string, string>;
  filesByKey: Record<string, PersistedFileEntry[]>;
}

type CloudFileReader = (entry: PersistedCloudPath) => Promise<File | null>;

let hydrateToken = 0;
let hydratedToken = -1;
let hydrateInflight: Promise<void> | null = null;
/**
 * Cloud paths restored from disk stay here until a File is in memory.
 * Writes before that read finishes must keep these entries, because memory
 * does not have them yet.
 */
let pendingCloudByKey: Record<string, PersistedCloudPath[]> = {};

async function readCloudFileFromDisk(entry: PersistedCloudPath): Promise<File | null> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(entry.path);
    return new File([new Uint8Array(bytes)], entry.name, {
      type: entry.type || "application/octet-stream",
    });
  } catch {
    return null;
  }
}

let cloudFileReader: CloudFileReader = readCloudFileFromDisk;

/** Test hook. Passing null restores the desktop file read. */
export function setComposerDraftCloudReader(reader: CloudFileReader | null): void {
  cloudFileReader = reader ?? readCloudFileFromDisk;
}

const EMPTY_PERSISTED: PersistedComposerDraft = { textByKey: {}, filesByKey: {} };

function isLocalAttachment(
  value: unknown,
): value is Extract<ComposerAttachment, { kind: "local" }> {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Extract<ComposerAttachment, { kind: "local" }>>;
  return (
    item.kind === "local" &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item.path === "string" &&
    item.path.length > 0 &&
    typeof item.size === "number" &&
    Number.isFinite(item.size)
  );
}

function isPersistedCloudPath(value: unknown): value is PersistedCloudPath {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PersistedCloudPath>;
  return (
    item.kind === "cloud" &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item.path === "string" &&
    item.path.length > 0 &&
    typeof item.type === "string" &&
    typeof item.size === "number" &&
    Number.isFinite(item.size)
  );
}

function parseFileEntries(value: unknown): PersistedFileEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: PersistedFileEntry[] = [];
  for (const item of value) {
    if (isLocalAttachment(item)) {
      entries.push({ kind: "local", name: item.name, size: item.size, path: item.path });
      continue;
    }
    if (isPersistedCloudPath(item)) entries.push(item);
  }
  return entries;
}

/** Text and paths only. A cloud file keeps the path it was picked from, not its bytes. */
export function persistedComposerDraft(state: {
  textByKey: Record<string, string>;
  filesByKey: Record<string, ComposerAttachment[]>;
}): PersistedComposerDraft {
  const textByKey: Record<string, string> = {};
  for (const [key, text] of Object.entries(state.textByKey)) {
    if (text) textByKey[key] = text;
  }
  const filesByKey: Record<string, PersistedFileEntry[]> = {};
  for (const [key, files] of Object.entries(state.filesByKey)) {
    const entries: PersistedFileEntry[] = [];
    for (const item of files) {
      if (isLocalAttachment(item)) {
        entries.push({ kind: "local", name: item.name, size: item.size, path: item.path });
        continue;
      }
      if (item.kind === "cloud" && item.path) {
        entries.push({
          kind: "cloud",
          name: item.file.name,
          size: item.file.size,
          path: item.path,
          type: item.file.type,
        });
      }
    }
    if (entries.length > 0) filesByKey[key] = entries;
  }
  return { textByKey, filesByKey };
}

export function parsePersistedComposerDraft(raw: unknown): PersistedComposerDraft {
  if (!raw || typeof raw !== "object") return EMPTY_PERSISTED;
  const record = raw as {
    textByKey?: unknown;
    filesByKey?: unknown;
  };
  const textByKey: Record<string, string> = {};
  if (record.textByKey && typeof record.textByKey === "object") {
    for (const [key, text] of Object.entries(record.textByKey)) {
      if (typeof text === "string" && text) textByKey[key] = text;
    }
  }
  const filesByKey: Record<string, PersistedFileEntry[]> = {};
  if (record.filesByKey && typeof record.filesByKey === "object") {
    for (const [key, entries] of Object.entries(record.filesByKey)) {
      const parsed = parseFileEntries(entries);
      if (parsed.length > 0) filesByKey[key] = parsed;
    }
  }
  return { textByKey, filesByKey };
}

function memoryFromPersisted(saved: PersistedComposerDraft): {
  textByKey: Record<string, string>;
  filesByKey: Record<string, ComposerAttachment[]>;
} {
  const filesByKey: Record<string, ComposerAttachment[]> = {};
  for (const [key, entries] of Object.entries(saved.filesByKey)) {
    const local = entries.filter((entry) => entry.kind === "local");
    if (local.length > 0) filesByKey[key] = local;
  }
  return { textByKey: saved.textByKey, filesByKey };
}

function cloudPathsFrom(saved: PersistedComposerDraft): Record<string, PersistedCloudPath[]> {
  const pending: Record<string, PersistedCloudPath[]> = {};
  for (const [key, entries] of Object.entries(saved.filesByKey)) {
    const clouds = entries.filter((entry): entry is PersistedCloudPath => entry.kind === "cloud");
    if (clouds.length > 0) pending[key] = clouds;
  }
  return pending;
}

function readPersisted(): PersistedComposerDraft {
  try {
    const raw = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw) return EMPTY_PERSISTED;
    return parsePersistedComposerDraft(JSON.parse(raw));
  } catch {
    return EMPTY_PERSISTED;
  }
}

function writePersisted(state: {
  textByKey: Record<string, string>;
  filesByKey: Record<string, ComposerAttachment[]>;
}): void {
  try {
    const snapshot = persistedComposerDraft(state);
    for (const key of Object.keys(pendingCloudByKey)) {
      const stored = new Set(
        (snapshot.filesByKey[key] ?? [])
          .filter((entry) => entry.kind === "cloud")
          .map((entry) => entry.path),
      );
      const left = pendingCloudByKey[key].filter((entry) => !stored.has(entry.path));
      if (left.length > 0) pendingCloudByKey[key] = left;
      else delete pendingCloudByKey[key];
    }
    for (const [key, pending] of Object.entries(pendingCloudByKey)) {
      const existing = snapshot.filesByKey[key] ?? [];
      const have = new Set(
        existing.filter((entry) => entry.kind === "cloud").map((entry) => entry.path),
      );
      const extra = pending.filter((entry) => !have.has(entry.path));
      if (extra.length > 0) snapshot.filesByKey[key] = [...existing, ...extra];
    }
    if (
      Object.keys(snapshot.textByKey).length === 0 &&
      Object.keys(snapshot.filesByKey).length === 0
    ) {
      localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* private mode or quota */
  }
}

const persistedAtLaunch = readPersisted();
const launchedMemory = memoryFromPersisted(persistedAtLaunch);
pendingCloudByKey = cloudPathsFrom(persistedAtLaunch);

function dropPending(key: string): void {
  delete pendingCloudByKey[key];
}

async function restoreCloudPaths(token: number): Promise<void> {
  const snapshot = Object.fromEntries(
    Object.entries(pendingCloudByKey).map(([key, entries]) => [
      key,
      entries.map((entry) => ({ ...entry })),
    ]),
  );
  const restored: Record<string, ComposerAttachment[]> = {};
  for (const [key, entries] of Object.entries(snapshot)) {
    const files: ComposerAttachment[] = [];
    for (const entry of entries) {
      const file = await cloudFileReader(entry);
      if (!file) continue;
      files.push({ kind: "cloud", file, path: entry.path });
    }
    if (files.length > 0) restored[key] = files;
  }
  if (token !== hydrateToken) return;
  const state = useComposerDraftStore.getState();
  const filesByKey = { ...state.filesByKey };
  let changed = false;
  for (const [key, files] of Object.entries(restored)) {
    const stillPending = new Set((pendingCloudByKey[key] ?? []).map((entry) => entry.path));
    const current = filesByKey[key] ?? [];
    const known = new Set(
      current.flatMap((item) => (item.kind === "cloud" && item.path ? [item.path] : [])),
    );
    const adding = files.filter(
      (item) =>
        item.kind === "cloud" &&
        item.path !== undefined &&
        stillPending.has(item.path) &&
        !known.has(item.path),
    );
    if (adding.length === 0) continue;
    filesByKey[key] = [...current, ...adding];
    changed = true;
    const loaded = new Set(
      adding.map((item) => (item.kind === "cloud" ? item.path : undefined)),
    );
    const left = (pendingCloudByKey[key] ?? []).filter((entry) => !loaded.has(entry.path));
    if (left.length > 0) pendingCloudByKey[key] = left;
    else dropPending(key);
  }
  if (changed) {
    useComposerDraftStore.setState({ filesByKey });
    writePersisted(useComposerDraftStore.getState());
  }
  hydratedToken = token;
}

/** Re-read cloud attachments from the paths saved with the draft. */
export function hydrateComposerDraftFiles(): Promise<void> {
  if (hydratedToken === hydrateToken) return Promise.resolve();
  if (hydrateInflight) return hydrateInflight;
  const token = hydrateToken;
  hydrateInflight = restoreCloudPaths(token)
    .catch(() => {})
    .finally(() => {
      hydrateInflight = null;
    });
  return hydrateInflight;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  textByKey: launchedMemory.textByKey,
  filesByKey: launchedMemory.filesByKey,
  text: (key) => get().textByKey[key] ?? "",
  files: (key) => get().filesByKey[key] ?? EMPTY_COMPOSER_FILES,
  setText: (key, text) => {
    let changed = false;
    set((s) => {
      if (!text) {
        if (!(key in s.textByKey)) return s;
        changed = true;
        return { textByKey: withoutKey(s.textByKey, key) };
      }
      if (s.textByKey[key] === text) return s;
      changed = true;
      return { textByKey: { ...s.textByKey, [key]: text } };
    });
    if (changed) writePersisted(get());
  },
  setFiles: (key, files) => {
    let changed = false;
    set((s) => {
      if (files.length === 0) {
        if (!(key in s.filesByKey)) return s;
        changed = true;
        return { filesByKey: withoutKey(s.filesByKey, key) };
      }
      if (s.filesByKey[key] === files) return s;
      changed = true;
      return { filesByKey: { ...s.filesByKey, [key]: files } };
    });
    if (changed) writePersisted(get());
  },
  updateFiles: (key, updater) => {
    const prev = get().files(key);
    const next = updater(prev);
    if (next === prev) return;
    get().setFiles(key, next);
  },
  copyOnto: (fromKey, toKey) => {
    if (fromKey === toKey) return;
    const pending = pendingCloudByKey[fromKey];
    set((s) => {
      const text = s.textByKey[fromKey];
      const files = s.filesByKey[fromKey];
      if (!text && !files?.length && !pending?.length) return s;
      return {
        textByKey: text ? { ...s.textByKey, [toKey]: text } : s.textByKey,
        filesByKey: files?.length ? { ...s.filesByKey, [toKey]: files } : s.filesByKey,
      };
    });
    if (pending?.length) pendingCloudByKey[toKey] = pending.map((entry) => ({ ...entry }));
    writePersisted(get());
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
    for (const key of keys) dropPending(key);
    writePersisted(get());
    return { text, files };
  },
  restore: (sessionId, text, files) => {
    get().setText(sessionId, text);
    get().setFiles(sessionId, files);
  },
  clear: (key) => {
    const hadPending = key in pendingCloudByKey;
    if (hadPending) dropPending(key);
    let changed = false;
    set((s) => {
      if (!(key in s.textByKey) && !(key in s.filesByKey)) return s;
      changed = true;
      return {
        textByKey: withoutKey(s.textByKey, key),
        filesByKey: withoutKey(s.filesByKey, key),
      };
    });
    if (changed || hadPending) writePersisted(get());
  },
  clearAll: () => {
    hydrateToken += 1;
    pendingCloudByKey = {};
    set({ textByKey: {}, filesByKey: {} });
    writePersisted(get());
  },
  loadPersisted: () => {
    hydrateToken += 1;
    const saved = readPersisted();
    pendingCloudByKey = cloudPathsFrom(saved);
    set(memoryFromPersisted(saved));
  },
}));
