import type { Message as StoreMessage } from "@/stores/session";

export type ThreadSummary = {
  threadSessionId: string;
  rootMessageId: string;
  messageCount: number;
  lastMessageAt: string | null;
  participantCount: number;
};

export function formatThreadRelativeTime(
  iso: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return t("thread.justNow");
  if (ms < 3_600_000) {
    return t("thread.minutesAgo", { n: Math.floor(ms / 60_000) });
  }
  if (ms < 86_400_000) {
    return t("thread.hoursAgo", { n: Math.floor(ms / 3_600_000) });
  }
  return t("thread.daysAgo", { n: Math.floor(ms / 86_400_000) });
}

export function threadTitleFromMessage(message: StoreMessage | null | undefined): string {
  const text = message?.content.trim() ?? "";
  if (!text) return "";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function sortThreadSummaries(items: ThreadSummary[]): ThreadSummary[] {
  return [...items].sort((a, b) => {
    const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bTime - aTime;
  });
}
