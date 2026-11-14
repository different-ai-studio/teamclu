import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useChatFilePreviewStore } from "@/stores/chat-file-preview-store";

const MIN_WIDTH = 280;
const MAX_WIDTH = 640;

export function ChatFilePreviewToggle() {
  const { t } = useTranslation();
  const count = useChatFilePreviewStore((s) => s.tabs.length);
  const collapsed = useChatFilePreviewStore((s) => s.collapsed);
  const toggle = useChatFilePreviewStore((s) => s.toggleCollapsed);
  if (count === 0) return null;
  const label = collapsed
    ? t("chat.fileOpen.expand", "展开阅读面板")
    : t("chat.fileOpen.collapse", "收起阅读面板");
  return (
    <button
      type="button"
      className={cn(
        "rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
        collapsed ? "text-muted-foreground" : "bg-selected text-foreground",
      )}
      onClick={() => toggle()}
      title={label}
      aria-label={label}
      aria-pressed={!collapsed}
    >
      <PanelRight className="h-4 w-4" />
    </button>
  );
}

export function ChatFilePreviewColumn() {
  const { t } = useTranslation();
  const tabs = useChatFilePreviewStore((s) => s.tabs);
  const activeId = useChatFilePreviewStore((s) => s.activeId);
  const collapsed = useChatFilePreviewStore((s) => s.collapsed);
  const width = useChatFilePreviewStore((s) => s.width);
  const setActive = useChatFilePreviewStore((s) => s.setActive);
  const closeTab = useChatFilePreviewStore((s) => s.closeTab);
  const setWidth = useChatFilePreviewStore((s) => s.setWidth);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const [body, setBody] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  const dragging = React.useRef(false);

  React.useEffect(() => {
    if (!active || collapsed) return;
    if (active.text != null) {
      setBody(active.text);
      setFailed(false);
      return;
    }
    if (!active.path) {
      setBody("");
      setFailed(true);
      return;
    }
    let cancelled = false;
    setFailed(false);
    void import("@tauri-apps/plugin-fs")
      .then(({ readTextFile }) => readTextFile(active.path!))
      .then((text) => {
        if (!cancelled) setBody(text);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active, collapsed]);

  const onGripDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed || tabs.length === 0) return;
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    dragging.current = true;
    const startX = event.clientX;
    const startW = width;
    const move = (e: PointerEvent) => {
      const parent = grip.parentElement?.parentElement?.clientWidth ?? window.innerWidth;
      const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parent - 360));
      const next = Math.round(Math.max(MIN_WIDTH, Math.min(max, startW + (startX - e.clientX))));
      setWidth(next);
    };
    const up = () => {
      dragging.current = false;
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };

  if (tabs.length === 0) return null;
  const shown = !collapsed;

  return (
    <section
      className={cn(
        "relative flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-border bg-background",
        shown ? "border-l" : "border-l-0",
      )}
      style={{ width: shown ? width : 0 }}
      data-chat-preview
      aria-label={t("chat.fileOpen.panel", "阅读面板")}
    >
      {shown ? (
      <div
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize"
        onPointerDown={onGripDown}
        title={t("chat.fileOpen.resize", "拖动改变宽度")}
      />
      ) : null}
      <div className={cn("flex h-10 shrink-0 items-end gap-0.5 overflow-hidden border-b border-border-soft bg-panel px-2 pr-2", !shown && "hidden")}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            data-preview-tab={tab.id}
            data-preview-path={tab.path ?? ""}
            data-preview-name={tab.name}
            aria-selected={tab.id === active?.id}
            className={cn(
              "flex h-7 max-w-[168px] min-w-0 cursor-pointer items-center gap-1 rounded-t-md px-2 text-[12px]",
              tab.id === active?.id
                ? "bg-background font-semibold text-foreground"
                : "text-muted-foreground hover:bg-background/60",
            )}
            onClick={() => setActive(tab.id)}
          >
            <span className="truncate">{tab.name}</span>
            <button
              type="button"
              className="rounded px-0.5 text-faint hover:bg-foreground/10 hover:text-foreground"
              aria-label={t("chat.fileOpen.closeTab", "关闭 {{name}}", { name: tab.name })}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className={cn("min-h-0 flex-1 overflow-auto", shown ? "min-w-[240px]" : "hidden")}>
        {failed ? (
          <p className="p-4 text-[13px] text-muted-foreground">
            {t("chat.fileOpen.readFailed", "读不到这个文件")}
          </p>
        ) : active?.kind === "html" ? (
          <iframe
            title={active.name}
            className="h-full w-full border-0 bg-white"
            sandbox=""
            srcDoc={body}
          />
        ) : (
          <article className="px-5 py-4 text-[13.5px] leading-[1.7] text-ink-2 [&_a]:underline [&_h1]:mb-2 [&_h1]:text-[20px] [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[15px] [&_h2]:font-semibold [&_li]:my-1 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </article>
        )}
      </div>
    </section>
  );
}
