import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThreadListPanelStore } from "@/stores/thread-list-panel-store";
import { useThreadPanelStore } from "@/stores/thread-panel-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { adaptTeamcluMessages } from "@/lib/messages/v2-message-adapter";
import { useSessionThreadSummaries } from "@/hooks/use-session-thread-summaries";
import {
  formatThreadRelativeTime,
  threadTitleFromMessage,
  type ThreadSummary,
} from "@/lib/session/thread-summary";
import { rememberThreadForkMetadata } from "@/lib/session/thread-fork-metadata";
import type { Message as ProtoMessage } from "@/lib/proto/teamclu_pb";

const EMPTY_PROTO_MESSAGES: ProtoMessage[] = [];
const THREAD_PANEL_WIDTH_PX = 380;
const THREAD_PANEL_MS = 300;

function anchorPreviewText(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= 120) return collapsed;
  return `${collapsed.slice(0, 120)}…`;
}

export function ThreadListPanel({ parentSessionId }: { parentSessionId: string }) {
  const { t } = useTranslation();
  const close = useThreadListPanelStore((s) => s.close);
  const reset = useThreadListPanelStore((s) => s.reset);
  const storeParentSessionId = useThreadListPanelStore((s) => s.parentSessionId);
  const isOpen = useThreadListPanelStore((s) => s.isOpen);
  const openThread = useThreadPanelStore((s) => s.open);

  const { summaries, loading, refresh } = useSessionThreadSummaries(parentSessionId);

  const parentMessages = useSessionMessageStore(
    (s) => s.messages[parentSessionId] ?? EMPTY_PROTO_MESSAGES,
  );
  const parentSdkMessages = React.useMemo(
    () => adaptTeamcluMessages(parentMessages) ?? [],
    [parentMessages],
  );
  const messagesById = React.useMemo(
    () => new Map(parentSdkMessages.map((m) => [m.id, m])),
    [parentSdkMessages],
  );

  const shouldExpand =
    isOpen && storeParentSessionId === parentSessionId;

  const [mounted, setMounted] = React.useState(shouldExpand);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (shouldExpand) {
      void refresh();
    }
  }, [shouldExpand, refresh]);

  React.useEffect(() => {
    if (shouldExpand) {
      setMounted(true);
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setExpanded(true));
      });
      return () => cancelAnimationFrame(raf);
    }

    setExpanded(false);
    const timer = window.setTimeout(() => {
      setMounted(false);
      if (!useThreadListPanelStore.getState().isOpen) {
        reset();
      }
    }, THREAD_PANEL_MS);
    return () => clearTimeout(timer);
  }, [shouldExpand, reset]);

  const handleSelect = React.useCallback(
    (summary: ThreadSummary) => {
      const anchor = messagesById.get(summary.rootMessageId) ?? null;
      rememberThreadForkMetadata(
        summary.threadSessionId,
        parentSessionId,
        summary.rootMessageId,
      );
      close();
      openThread({
        parentSessionId,
        rootMessageId: summary.rootMessageId,
        threadSessionId: summary.threadSessionId,
        title: threadTitleFromMessage(anchor) || t("thread.defaultTitle"),
      });
    },
    [messagesById, close, openThread, parentSessionId, t],
  );

  if (!mounted) return null;

  return (
    <div
      data-testid="thread-list-panel-shell"
      className={cn(
        "relative z-30 h-full min-h-0 shrink-0 overflow-hidden",
        "transition-[width] duration-300 ease-out motion-reduce:transition-none",
        expanded ? "w-[380px]" : "w-0",
      )}
      style={{ transitionDuration: `${THREAD_PANEL_MS}ms` }}
    >
      <aside
        data-testid="thread-list-panel"
        className={cn(
          "flex h-full flex-col border-l border-border bg-background shadow-[-8px_0_24px_-12px_rgba(20,20,15,0.12)]",
          "transition-transform ease-out motion-reduce:transition-none",
          expanded ? "translate-x-0" : "translate-x-full",
        )}
        style={{
          width: THREAD_PANEL_WIDTH_PX,
          transitionDuration: `${THREAD_PANEL_MS}ms`,
        }}
      >
        <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border-soft px-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">
              {t("thread.listTitle")}
            </div>
            <div className="mt-0.5 text-[11.5px] text-faint">
              {t("thread.listSubtitle", { count: summaries.length })}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-faint hover:bg-selected"
            aria-label={t("thread.listClose")}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading && summaries.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("thread.listLoading")}
            </div>
          ) : null}

          {!loading && summaries.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">
              {t("thread.listEmpty")}
            </p>
          ) : null}

          <ul className="space-y-1">
            {summaries.map((summary) => {
              const anchor = messagesById.get(summary.rootMessageId) ?? null;
              const title =
                threadTitleFromMessage(anchor) || t("thread.defaultTitle");
              const preview = anchorPreviewText(anchor?.content ?? "");
              const lastReply = summary.lastMessageAt
                ? formatThreadRelativeTime(summary.lastMessageAt, t)
                : "";

              return (
                <li key={summary.threadSessionId}>
                  <button
                    type="button"
                    data-testid="thread-list-item"
                    onClick={() => handleSelect(summary)}
                    className="w-full rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-paper"
                  >
                    <div className="truncate text-[13px] font-semibold text-ink-2">
                      {title}
                    </div>
                    {preview ? (
                      <p className="mt-1 line-clamp-2 text-[12px] leading-[1.5] text-muted-foreground">
                        {preview}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-faint">
                      <span>{t("thread.replies", { count: summary.messageCount })}</span>
                      {lastReply ? (
                        <span>{t("thread.lastReply", { time: lastReply })}</span>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}
