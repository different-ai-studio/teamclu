/** Long enough to absorb the burst a session switch fires; short enough to never outlive a real change. */
export const COALESCED_READ_TTL_MS = 2_000;

export type CoalescedRead<V> = {
  get(key: string, load: () => Promise<V>, options?: { fresh?: boolean }): Promise<V>;
  invalidate(key?: string): void;
};

type Entry<V> = { promise: Promise<V>; settledAt: number | null };

/**
 * Callers asking for the same key while a request is in flight share it, and a
 * settled answer is reused for `ttlMs`. Rejections and values `cacheable`
 * refuses are never kept.
 */
export function createCoalescedRead<V>(options: {
  ttlMs?: number;
  cacheable?: (value: V) => boolean;
  now?: () => number;
}): CoalescedRead<V> {
  const ttlMs = options.ttlMs ?? COALESCED_READ_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<V>>();

  const isLive = (entry: Entry<V>) =>
    entry.settledAt === null || now() - entry.settledAt < ttlMs;

  return {
    get(key, load, getOptions) {
      const hit = entries.get(key);
      if (hit && !getOptions?.fresh && isLive(hit)) return hit.promise;

      const entry: Entry<V> = { promise: Promise.resolve() as Promise<V>, settledAt: null };
      entry.promise = load().then(
        (value) => {
          if (entries.get(key) !== entry) return value;
          if (options.cacheable && !options.cacheable(value)) {
            entries.delete(key);
          } else {
            entry.settledAt = now();
            setTimeout(() => {
              if (entries.get(key) === entry) entries.delete(key);
            }, ttlMs);
          }
          return value;
        },
        (error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      entries.set(key, entry);
      return entry.promise;
    },
    invalidate(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}
