import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Copy, FolderOpen, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatAcpDebugFileBlock,
  formatAcpDebugLine,
  getAcpDebugLogDirectory,
  revealAcpDebugLog,
} from "@/lib/acp-debug-file-log";
import { isTauri } from "@/lib/utils";
import {
  ACP_DEBUG_PANEL_LINES,
  isAcpDebugPanelVisible,
  useAcpDebugStore,
} from "@/stores/acp-debug-store";

export function AcpStreamDebugPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation();
  const enabled = useAcpDebugStore((s) => s.enabled);
  const allLines = useAcpDebugStore((s) => s.lines);
  const clear = useAcpDebugStore((s) => s.clear);
  const [collapsed, setCollapsed] = React.useState(false);
  const [logDir, setLogDir] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const sessionLines = React.useMemo(() => {
    if (!sessionId) return [];
    return allLines.filter((l) => l.sessionId === sessionId);
  }, [allLines, sessionId]);

  const lines = React.useMemo(
    () => sessionLines.slice(-ACP_DEBUG_PANEL_LINES),
    [sessionLines],
  );

  React.useEffect(() => {
    if (!isTauri()) return;
    void getAcpDebugLogDirectory().then(setLogDir);
  }, []);

  React.useEffect(() => {
    if (collapsed || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines.length, collapsed]);

  if (!isAcpDebugPanelVisible() || !enabled || !sessionId) return null;

  const copyAll = async () => {
    const text = sessionLines.map((l) => formatAcpDebugFileBlock(l).trimEnd()).join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn("[acp-debug] copy failed", e);
    }
  };

  const logFileHint = t("chat.acpDebug.logFileSession", "{{dir}}/{{sessionId}}.log + _all.log", {
    dir: logDir ?? "…",
    sessionId: sessionId.slice(0, 8),
  });

  return (
    <div
      data-testid="acp-stream-debug-panel"
      className="shrink-0 border-b border-border/80 bg-panel/90"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">
          {t("chat.acpDebug.title", "ACP 流调试")}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {t("chat.acpDebug.lineCount", "{{shown}} / {{total}} 条", {
            shown: lines.length,
            total: sessionLines.length,
          })}
          {` · ${t("chat.acpDebug.scopeCurrentSession", "当前会话")}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {isTauri() ? (
            <button
              type="button"
              onClick={() => void revealAcpDebugLog(sessionId)}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
              title={t("chat.acpDebug.openLog", "在 Finder 中打开日志")}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void copyAll()}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
            title={t("chat.acpDebug.copy", "复制")}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={clear}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
            title={t("chat.acpDebug.clear", "清空面板（不影响日志文件）")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
          >
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {isTauri() && logDir ? (
        <p
          className="truncate px-3 pb-1 font-mono text-[10px] text-faint"
          title={logDir}
        >
          {logFileHint}
        </p>
      ) : null}
      {!collapsed ? (
        <div
          ref={scrollRef}
          className={cn(
            "max-h-[min(28vh,220px)] overflow-auto px-3 pb-2",
            "font-mono text-[10.5px] leading-relaxed text-ink-2",
          )}
        >
          {lines.length === 0 ? (
            <p className="py-2 text-muted-foreground">
              {t("chat.acpDebug.waiting", "等待 {{token}} …", { token: "acp.event" })}
            </p>
          ) : (
            lines.map((line) => (
              <pre
                key={line.id}
                className="mb-2 whitespace-pre-wrap break-all rounded border border-border-soft bg-paper/80 p-2 last:mb-0"
              >
                {formatAcpDebugLine(line)}
              </pre>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
