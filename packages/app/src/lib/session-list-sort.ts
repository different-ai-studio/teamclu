type SessionListSortKey = {
  id: string;
  last_message_at?: string | null;
  lastMessageAt?: Date | null;
  created_at?: string | null;
  createdAt?: Date | null;
};

function lastMessageAtMs(row: SessionListSortKey): number | null {
  if (row.lastMessageAt instanceof Date) return row.lastMessageAt.getTime();
  if (row.last_message_at) return new Date(row.last_message_at).getTime();
  return null;
}

function createdAtValue(row: SessionListSortKey): string {
  if (row.createdAt instanceof Date) return row.createdAt.toISOString();
  return row.created_at ?? "";
}

/** Match backend listSessions: last_message_at DESC NULLS FIRST, created_at DESC, id DESC. */
export function compareSessionListByRecency(a: SessionListSortKey, b: SessionListSortKey): number {
  const aLast = lastMessageAtMs(a);
  const bLast = lastMessageAtMs(b);
  if (aLast == null && bLast != null) return -1;
  if (aLast != null && bLast == null) return 1;
  if (aLast != null && bLast != null && aLast !== bLast) return bLast - aLast;
  const byCreated = createdAtValue(b).localeCompare(createdAtValue(a));
  if (byCreated !== 0) return byCreated;
  return b.id.localeCompare(a.id);
}

export function sortSessionListRows<T extends SessionListSortKey>(rows: T[]): T[] {
  return [...rows].sort(compareSessionListByRecency);
}
