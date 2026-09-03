import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  sessionHasAgentStreamActivitySince,
  sessionHasMentionedRuntimeActiveSince,
} from "@/lib/outbox-ui-display";
import { useOutboxStore } from "@/stores/outbox-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { cn } from "@/lib/utils";

function DeliveredCheck({ title }: { title: string }) {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center"
      title={title}
      data-testid="msg-status-delivered"
    >
      <Check className="h-3 w-3 text-muted-foreground/60" />
    </span>
  );
}

/** Per-bubble outbox status dot. Reads the live outbox entry for `messageId`;
 * if none exists the message has either never been outboxed (historical row
 * from Supabase) or has been GC'd after delivery — in both cases the dot is
 * hidden. Mirrors iOS `OutboxStatusDot`. */
export function MessageStatusDot({ messageId }: { messageId: string }) {
  const entry = useOutboxStore((s) => s.byId[messageId]);
  const retry = useOutboxStore((s) => s.retry);
  const cloudPersisted = useOutboxStore((s) => Boolean(s.cloudPersistedIds[messageId]));
  // PERF-14: `revisionBySession` ticks once per streaming frame, so subscribing
  // to it from every visible bubble re-rendered the whole list at frame rate —
  // 80 dots recomputing a status only one of them could change. The revision
  // only feeds `agentTurnVisible`, which is gated on `inTransit`, so a
  // delivered or failed bubble asks for a constant and stops re-rendering.
  const inTransit = entry?.state === "pending" || entry?.state === "inFlight";
  const sessionId = inTransit ? entry?.sessionId : undefined;
  const streamRevision = useV2StreamingStore((s) =>
    sessionId ? (s.revisionBySession[sessionId] ?? 0) : 0,
  );
  const runtimeById = useRuntimeStateStore((s) => s.byRuntimeId);
  const { t } = useTranslation();
  if (!entry) return null;

  const deliveredTitle = t("chat.sendStatus.delivered", "Delivered");
  const { byKey: streamsByKey, archived: streamsArchived } =
    useV2StreamingStore.getState();
  void streamRevision;
  const agentTurnVisible =
    inTransit &&
    (sessionHasAgentStreamActivitySince(entry.sessionId, entry.createdAt, {
      byKey: streamsByKey,
      archived: streamsArchived,
    }) ||
      sessionHasMentionedRuntimeActiveSince(
        entry.mentionActorIds,
        entry.createdAt,
        runtimeById,
      ));

  if (entry.state === "delivered" || cloudPersisted || agentTurnVisible) {
    return <DeliveredCheck title={deliveredTitle} />;
  }

  if (entry.state === "failed") {
    return (
      <button
        type="button"
        onClick={() => void retry(entry.messageId)}
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded-full",
          "text-destructive hover:bg-destructive/10 transition-colors",
        )}
        title={
          entry.lastError
            ? `${t("chat.sendStatus.failedClickToRetry", "Failed — click to retry")}: ${entry.lastError}`
            : t("chat.sendStatus.failedClickToRetry", "Failed — click to retry")
        }
        data-testid="msg-status-failed"
      >
        <AlertCircle className="h-3.5 w-3.5" />
      </button>
    );
  }

  // pending or inFlight — same visual (a spinner). UI doesn't distinguish
  // "waiting in queue" from "actively sending" — both are "in transit"
  // from the user's perspective.
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center"
      title={t("chat.sendStatus.sending", "Sending…")}
      data-testid="msg-status-sending"
    >
      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/70" />
    </span>
  );
}
