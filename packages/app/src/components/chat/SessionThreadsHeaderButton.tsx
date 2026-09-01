import { MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useSessionThreadSummaries } from "@/hooks/use-session-thread-summaries";
import { useThreadListPanelStore } from "@/stores/thread-list-panel-store";

export function SessionThreadsHeaderButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { summaries, hasThreads } = useSessionThreadSummaries(sessionId);
  const isOpen = useThreadListPanelStore(
    (s) => s.isOpen && s.parentSessionId === sessionId,
  );
  const toggle = useThreadListPanelStore((s) => s.toggle);

  if (!hasThreads) return null;

  return (
    <button
      type="button"
      data-testid="session-threads-header-button"
      className={cn(
        "flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
        isOpen
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={() => toggle(sessionId)}
      title={t("thread.listOpen")}
    >
      <MessagesSquare className="h-4 w-4" />
      {isOpen ? <span>{t("thread.listTitle")}</span> : null}
      {summaries.length > 0 ? (
        <span
          className={cn(
            "min-w-[1.1rem] rounded px-1 text-center font-mono text-[10px] leading-4",
            isOpen ? "bg-background/70" : "bg-muted",
          )}
        >
          {summaries.length}
        </span>
      ) : null}
    </button>
  );
}
