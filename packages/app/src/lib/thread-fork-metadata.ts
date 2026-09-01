import { getBackend } from "@/lib/backend";
import type { SessionDetailRow } from "@/lib/backend/types";

export type ThreadForkAnchor = {
  parentSessionId: string;
  rootMessageId: string;
};

/** threadSessionId → fork anchor (survives panel close / reconnect). */
const memory = new Map<string, ThreadForkAnchor>();

export function rememberThreadForkMetadata(
  threadSessionId: string,
  parentSessionId: string | null | undefined,
  rootMessageId: string | null | undefined,
): void {
  const tid = threadSessionId.trim();
  const pid = parentSessionId?.trim();
  const rid = rootMessageId?.trim();
  if (!tid || !pid || !rid) return;
  memory.set(tid, { parentSessionId: pid, rootMessageId: rid });
}

export function rememberThreadForkFromSessionDetail(
  row: SessionDetailRow | null | undefined,
): void {
  if (!row?.id) return;
  rememberThreadForkMetadata(
    row.id,
    row.parent_session_id,
    row.thread_root_message_id,
  );
}

export function resolveThreadForkFrom(
  threadSessionId: string,
): ThreadForkAnchor | undefined {
  return memory.get(threadSessionId.trim());
}

/** Warm fork anchor when a thread session becomes active (e.g. panel reopen). */
export async function preloadThreadForkMetadata(
  threadSessionId: string,
  teamId: string | null,
): Promise<void> {
  if (resolveThreadForkFrom(threadSessionId)) return;
  const detail = await getBackend().sessions.getSession(threadSessionId, teamId);
  rememberThreadForkFromSessionDetail(detail);
}

/** @internal test-only */
export function clearThreadForkMetadataForTests(): void {
  memory.clear();
}
