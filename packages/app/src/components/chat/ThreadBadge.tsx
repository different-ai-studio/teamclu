import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThreadPanelStore } from "@/stores/thread-panel-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { MessageKind } from "@/lib/proto/teamclu_pb";
import type { Message as StoreMessage } from "@/stores/session";

import { threadTitleFromMessage, formatThreadRelativeTime } from "@/lib/thread-summary";
import { useThreadListPanelStore } from "@/stores/thread-list-panel-store";
import { useThreadSummaryForMessage } from "@/hooks/use-session-thread-summaries";
import { rememberThreadForkMetadata } from "@/lib/thread-fork-metadata";
import { MessageActionIconButton } from "./MessageActionIconButton";

export function ThreadBadge({
  parentSessionId,
  messageId,
  message,
  hideThread = false,
  copySlot = null,
  actionsRevealed = false,
}: {
  parentSessionId: string;
  messageId: string;
  message: StoreMessage;
  hideThread?: boolean;
  copySlot?: React.ReactNode;
  actionsRevealed?: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useThreadPanelStore((s) => s.toggle);
  const isActive = useThreadPanelStore(
    (s) =>
      s.isOpen &&
      s.parentSessionId === parentSessionId &&
      s.rootMessageId === messageId,
  );
  const rawKind = useSessionMessageStore((s) => {
    const row = s.messages[parentSessionId]?.find((m) => m.messageId === messageId);
    return row?.kind;
  });

  const isAgentReply =
    message.role === "assistant" &&
    !message.isStreaming &&
    (rawKind === MessageKind.AGENT_REPLY || rawKind === undefined);

  const summary = useThreadSummaryForMessage(
    parentSessionId,
    messageId,
    isAgentReply && !hideThread,
  );

  const panelThreadSessionId = useThreadPanelStore((s) =>
    s.rootMessageId === messageId && s.parentSessionId === parentSessionId
      ? s.threadSessionId
      : null,
  );
  const hasThread =
    Boolean(summary?.threadSessionId) || Boolean(panelThreadSessionId);

  const showThread = isAgentReply && !hideThread;
  if (!showThread && !copySlot) return null;

  const onOpen = () => {
    useThreadListPanelStore.getState().close();
    const threadSessionId =
      summary?.threadSessionId ?? panelThreadSessionId ?? null;
    if (threadSessionId) {
      rememberThreadForkMetadata(threadSessionId, parentSessionId, messageId);
    }
    toggle({
      parentSessionId,
      threadSessionId,
      rootMessageId: messageId,
      title: threadTitleFromMessage(message) || t("thread.defaultTitle"),
    });
  };

  const hasThreadUi =
    hasThread || Boolean(summary && summary.messageCount > 0);

  const threadReplyBadge =
    showThread && hasThreadUi ? (
      <button
        type="button"
        data-testid="thread-badge"
        onClick={onOpen}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] text-ink-2 transition-colors",
          isActive && "bg-selected",
        )}
      >
        <span aria-hidden>💬</span>
        <span className="truncate">
          {summary
            ? t("thread.replies", { count: summary.messageCount })
            : t("thread.continue")}
          {summary?.lastMessageAt
            ? ` · ${t("thread.lastReply", {
                time: formatThreadRelativeTime(summary.lastMessageAt, t),
              })}`
            : ""}
        </span>
      </button>
    ) : null;

  const startThreadButton =
    showThread && !hasThreadUi ? (
      <MessageActionIconButton
        label={t("thread.tooltipStart")}
        onClick={onOpen}
        testId="thread-badge-start"
        active={isActive}
      >
        <GitBranch className="h-3.5 w-3.5" strokeWidth={2} />
      </MessageActionIconButton>
    ) : null;

  const copyRow = copySlot ? (
    <div
      className={cn(
        "transition-opacity",
        !actionsRevealed && "opacity-0 group-hover/msg:opacity-100",
      )}
    >
      {copySlot}
    </div>
  ) : null;

  if (hasThreadUi && threadReplyBadge) {
    return (
      <div className="mt-1 pl-1">
        {threadReplyBadge}
        {copyRow ? <div className="mt-0.5">{copyRow}</div> : null}
      </div>
    );
  }

  if (!copySlot && !startThreadButton) return null;

  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-0.5 pl-1 transition-opacity",
        !actionsRevealed && !isActive && "opacity-0 group-hover/msg:opacity-100",
      )}
    >
      {copySlot}
      {startThreadButton}
    </div>
  );
}
