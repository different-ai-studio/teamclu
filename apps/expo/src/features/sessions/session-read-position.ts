import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Where the reader left a session (iOS `SessionReadPositionStore`, #1709).
 *
 * - `readAt`: the newest row this device has shown the reader. Rows from other
 *   people after it are "unread" on reopen. Device-local: the server's read
 *   marker is written but never read back, so this does not follow the user
 *   to another device.
 * - `anchorKey`: the feed row at the top of the screen when they left from the
 *   middle of the history; null when they left at the bottom.
 */
export type SessionReadPosition = {
  readAt: string;
  anchorKey: string | null;
};

const STORAGE_PREFIX = "teamclu.readPosition.v1:";

let positions = new Map<string, SessionReadPosition>();
let hydrated: Promise<void> | null = null;

function parse(raw: string | null): SessionReadPosition | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionReadPosition>;
    if (typeof value.readAt !== "string") return null;
    return {
      readAt: value.readAt,
      anchorKey: typeof value.anchorKey === "string" ? value.anchorKey : null,
    };
  } catch {
    return null;
  }
}

/** Load every stored position once, so the screen can read one synchronously. */
export function hydrateReadPositions(): Promise<void> {
  hydrated ??= (async () => {
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(STORAGE_PREFIX));
      if (keys.length === 0) return;
      const entries = await AsyncStorage.multiGet(keys);
      const next = new Map(positions);
      for (const [k, raw] of entries) {
        const sessionId = k.slice(STORAGE_PREFIX.length);
        const parsed = parse(raw);
        if (parsed && !next.has(sessionId)) next.set(sessionId, parsed);
      }
      positions = next;
    } catch {
      // best-effort: the session just opens at the bottom
    }
  })();
  return hydrated;
}

export function getReadPosition(sessionId: string): SessionReadPosition | null {
  return positions.get(sessionId) ?? null;
}

export async function saveReadPosition(
  sessionId: string,
  position: SessionReadPosition,
): Promise<void> {
  positions = new Map(positions).set(sessionId, position);
  try {
    await AsyncStorage.setItem(`${STORAGE_PREFIX}${sessionId}`, JSON.stringify(position));
  } catch {
    // best-effort
  }
}

export async function clearReadPositions(): Promise<void> {
  positions = new Map();
  hydrated = null;
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(STORAGE_PREFIX));
    await AsyncStorage.multiRemove(keys);
  } catch {
    // best-effort
  }
}

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function laterIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return timeOf(b) > timeOf(a) ? b : a;
}

export type ReadPositionRow = {
  key: string;
  createdAt: string;
  /** Whether the reader wrote this row themselves. */
  isOwn: boolean;
};

/** iOS shows the "N unread ↑" pill from this many unread rows. */
export const FIRST_UNREAD_THRESHOLD = 5;

/**
 * Rows other people posted after `readAt`, and the first of them. Own rows
 * never count: you have read what you wrote.
 */
export function unreadSince(
  rows: readonly ReadPositionRow[],
  readAt: string | null,
): { count: number; firstKey: string | null } {
  if (!readAt) return { count: 0, firstKey: null };
  const since = timeOf(readAt);
  let count = 0;
  let firstKey: string | null = null;
  for (const row of rows) {
    if (row.isOwn || timeOf(row.createdAt) <= since) continue;
    count += 1;
    firstKey ??= row.key;
  }
  return { count, firstKey };
}

/**
 * The position to save when the reader leaves.
 *
 * At the bottom they have seen everything: `readAt` is the newest row, no
 * anchor. In the middle they have seen up to the newest *visible* row — but
 * scrolling back up to reread must not un-read what they already saw, so
 * `readAt` never moves backwards.
 */
export function positionOnLeave(input: {
  previous: SessionReadPosition | null;
  rows: readonly ReadPositionRow[];
  visibleKeys: readonly string[];
  isAtBottom: boolean;
}): SessionReadPosition | null {
  const { previous, rows, visibleKeys, isAtBottom } = input;
  if (rows.length === 0) return previous;
  if (isAtBottom || visibleKeys.length === 0) {
    return {
      readAt: laterIso(previous?.readAt, rows[rows.length - 1]!.createdAt)!,
      anchorKey: null,
    };
  }
  const visible = new Set(visibleKeys);
  let topKey: string | null = null;
  let newestVisible: string | null = null;
  for (const row of rows) {
    if (!visible.has(row.key)) continue;
    topKey ??= row.key;
    newestVisible = laterIso(newestVisible, row.createdAt);
  }
  return {
    readAt: laterIso(previous?.readAt, newestVisible) ?? rows[rows.length - 1]!.createdAt,
    anchorKey: topKey,
  };
}

/** "99+" past 99, like the iOS jump-to-bottom badge. */
export function formatNewMessageCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
