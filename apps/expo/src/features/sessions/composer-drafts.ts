import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_PREFIX = "teamclu.composerDraft.v1:";

function key(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

// In-memory mirror of every saved draft, so the session list can show
// "Draft: …" on a row without an AsyncStorage read per row (iOS #1709).
let drafts = new Map<string, string>();
let hydrated: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setCached(sessionId: string, value: string) {
  const current = drafts.get(sessionId) ?? "";
  if (current === value) return;
  const next = new Map(drafts);
  if (value) next.set(sessionId, value);
  else next.delete(sessionId);
  drafts = next;
  emit();
}

/** Load every stored draft into memory once; later calls reuse the first. */
export function hydrateComposerDrafts(): Promise<void> {
  hydrated ??= (async () => {
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(STORAGE_PREFIX));
      if (keys.length === 0) return;
      const entries = await AsyncStorage.multiGet(keys);
      const next = new Map(drafts);
      for (const [k, v] of entries) {
        const sessionId = k.slice(STORAGE_PREFIX.length);
        // A save made while hydrating is newer than what was on disk.
        if (v && !next.has(sessionId)) next.set(sessionId, v);
      }
      drafts = next;
      emit();
    } catch {
      // best-effort: rows just show no draft
    }
  })();
  return hydrated;
}

export function subscribeComposerDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getComposerDraftsSnapshot(): ReadonlyMap<string, string> {
  return drafts;
}

export async function loadComposerDraft(sessionId: string): Promise<string> {
  const cached = drafts.get(sessionId);
  if (cached) return cached;
  try {
    return (await AsyncStorage.getItem(key(sessionId))) ?? "";
  } catch {
    return "";
  }
}

export async function saveComposerDraft(
  sessionId: string,
  value: string,
): Promise<void> {
  // Whitespace alone is not a draft worth a "Draft:" label.
  const stored = value.trim().length > 0 ? value : "";
  setCached(sessionId, stored);
  try {
    if (!stored) {
      await AsyncStorage.removeItem(key(sessionId));
    } else {
      await AsyncStorage.setItem(key(sessionId), stored);
    }
  } catch {
    // best-effort
  }
}

/** Sign-out: drafts belong to the account that wrote them. */
export async function clearComposerDrafts(): Promise<void> {
  const keys = [...drafts.keys()].map(key);
  drafts = new Map();
  hydrated = null;
  emit();
  try {
    const stored = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(STORAGE_PREFIX));
    await AsyncStorage.multiRemove([...new Set([...keys, ...stored])]);
  } catch {
    // best-effort
  }
}
