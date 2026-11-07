import {
  SESSION_LIST_KINDS,
  type SessionListKind,
} from "@/lib/session/session-list-kind";

export type SessionAttentionEntry = {
  kind: SessionListKind;
  mention: boolean;
};

export type KindAttentionCounts = {
  unread: number;
  mention: number;
};

export type AttentionByKind = Record<SessionListKind, KindAttentionCounts>;

export function emptyAttentionByKind(): AttentionByKind {
  return {
    regular: { unread: 0, mention: 0 },
    channel: { unread: 0, mention: 0 },
    app: { unread: 0, mention: 0 },
    cron: { unread: 0, mention: 0 },
  };
}

/** Aggregate per-session attention into kind buckets. O(n) over tracked sessions. */
export function aggregateAttentionByKind(
  attention: Readonly<Record<string, SessionAttentionEntry>>,
): AttentionByKind {
  const out = emptyAttentionByKind();
  for (const entry of Object.values(attention)) {
    out[entry.kind].unread += 1;
    if (entry.mention) out[entry.kind].mention += 1;
  }
  return out;
}

export function totalAttention(counts: AttentionByKind): KindAttentionCounts {
  let unread = 0;
  let mention = 0;
  for (const kind of SESSION_LIST_KINDS) {
    unread += counts[kind].unread;
    mention += counts[kind].mention;
  }
  return { unread, mention };
}

export function isSessionListKindValue(value: unknown): value is SessionListKind {
  return (
    value === "regular" ||
    value === "channel" ||
    value === "app" ||
    value === "cron"
  );
}
