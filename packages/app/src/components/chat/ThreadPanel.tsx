import * as React from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThreadPanelStore } from "@/stores/thread-panel-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { adaptTeamcluMessages } from "@/lib/messages/v2-message-adapter";
import { ThreadAnchorPreview } from "./ThreadAnchorPreview";
import { SessionChatColumn } from "./SessionChatColumn";
import { getBackend } from "@/lib/backend";
import { toast } from "sonner";
import { useSessionLiveInterestStore } from "@/stores/session-live-interest-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { threadDraftSessionId } from "@/lib/session/thread-fork";
import {
  rememberThreadForkMetadata,
  preloadThreadForkMetadata,
} from "@/lib/session/thread-fork-metadata";
import type { Message as ProtoMessage } from "@/lib/proto/teamclu_pb";
import {
  clampThreadPanelWidth,
  hasSeenThreadPanelResizeHint,
  markThreadPanelResizeHintSeen,
  readThreadPanelWidth,
  resizeThreadPanelWidth,
  THREAD_PANEL_WIDTH_DEFAULT,
  THREAD_PANEL_WIDTH_MIN,
  threadPanelWidthMax,
  writeThreadPanelWidth,
} from "@/lib/ui/thread-panel-width";

const EMPTY_PROTO_MESSAGES: ProtoMessage[] = [];
const THREAD_PANEL_MS = 300;
const THREAD_PANEL_KEYBOARD_STEP = 24;
const RESIZE_HINT_MS = 1800;

function ThreadPanelResizeHandle({
  width,
  maxWidth,
  hinting,
  onDragStart,
  onDelta,
  onCommit,
  onReset,
}: {
  width: number;
  maxWidth: number;
  hinting: boolean;
  onDragStart: () => void;
  onDelta: (deltaX: number) => void;
  onCommit: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const dragging = React.useRef(false);
  const lastX = React.useRef(0);
  const [active, setActive] = React.useState(false);
  const label = t("thread.resize");

  const end = React.useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    onCommit();
  }, [onCommit]);

  React.useEffect(() => {
    if (!active) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [active]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={THREAD_PANEL_WIDTH_MIN}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      title={label}
      tabIndex={0}
      data-testid="thread-panel-resize-handle"
      className="group absolute inset-y-0 left-0 z-40 w-3 cursor-col-resize touch-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging.current = true;
        lastX.current = event.clientX;
        setActive(true);
        onDragStart();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* jsdom has no pointer capture */
        }
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const delta = event.clientX - lastX.current;
        lastX.current = event.clientX;
        if (delta !== 0) onDelta(delta);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(event) => {
        event.preventDefault();
        onReset();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onDragStart();
          onDelta(-THREAD_PANEL_KEYBOARD_STEP);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onDragStart();
          onDelta(THREAD_PANEL_KEYBOARD_STEP);
        }
      }}
      onBlur={end}
      onKeyUp={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") onCommit();
      }}
    >
      <div
        className={cn(
          "h-full w-px",
          active
            ? "bg-foreground/30"
            : hinting
              ? "bg-foreground/40 thread-resize-hint-edge"
              : "bg-transparent group-hover:bg-foreground/20",
        )}
      />
    </div>
  );
}

export function ThreadPanel({ parentSessionId }: { parentSessionId: string }) {
  const { t } = useTranslation();
  const close = useThreadPanelStore((s) => s.close);
  const setThreadSessionId = useThreadPanelStore((s) => s.setThreadSessionId);
  const storeParentSessionId = useThreadPanelStore((s) => s.parentSessionId);
  const threadSessionId = useThreadPanelStore((s) => s.threadSessionId);
  const rootMessageId = useThreadPanelStore((s) => s.rootMessageId);
  const title = useThreadPanelStore((s) => s.title);
  const isOpen = useThreadPanelStore((s) => s.isOpen);
  const ensureParticipants = useSessionParticipantStore((s) => s.ensureParticipants);

  const parentMessages = useSessionMessageStore(
    (s) => s.messages[parentSessionId] ?? EMPTY_PROTO_MESSAGES,
  );

  const anchorSdk = React.useMemo(() => {
    if (!rootMessageId) return null;
    return adaptTeamcluMessages(parentMessages)?.find((m) => m.id === rootMessageId) ?? null;
  }, [parentMessages, rootMessageId]);

  const composerSessionId =
    threadSessionId ??
    (rootMessageId ? threadDraftSessionId(parentSessionId, rootMessageId) : null);

  const ensureSessionBeforeSend = React.useCallback(async () => {
    if (threadSessionId) return threadSessionId;
    if (!rootMessageId) {
      throw new Error("missing thread anchor");
    }
    const draftKey = threadDraftSessionId(parentSessionId, rootMessageId);
    const session = await getBackend().sessions.createThread(parentSessionId, rootMessageId);
    const draftAgents = useEngagedAgentStore.getState().getAgents(draftKey);
    if (draftAgents.length > 0) {
      useEngagedAgentStore.getState().setAgents(session.id, draftAgents);
      useEngagedAgentStore.getState().clearSession(draftKey);
    }
    setThreadSessionId(session.id);
    rememberThreadForkMetadata(session.id, parentSessionId, rootMessageId);
    useSessionLiveInterestStore.getState().noteSessionOpened(session.id);
    await ensureParticipants([session.id]);
    return session.id;
  }, [
    threadSessionId,
    rootMessageId,
    parentSessionId,
    setThreadSessionId,
    ensureParticipants,
  ]);

  const wrappedEnsureSessionBeforeSend = React.useCallback(async () => {
    try {
      return await ensureSessionBeforeSend();
    } catch (err) {
      toast.error(t("thread.createFailed"), {
        description: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }, [ensureSessionBeforeSend, t]);

  React.useEffect(() => {
    if (!isOpen || !threadSessionId) return;
    useSessionLiveInterestStore.getState().noteSessionOpened(threadSessionId);
  }, [isOpen, threadSessionId]);

  React.useEffect(() => {
    if (!isOpen || !threadSessionId || !rootMessageId) return;
    rememberThreadForkMetadata(threadSessionId, parentSessionId, rootMessageId);
  }, [isOpen, threadSessionId, parentSessionId, rootMessageId]);

  React.useEffect(() => {
    if (!isOpen || !threadSessionId) return;
    const parentTeamId =
      useSessionListStore.getState().rows.find((r) => r.id === parentSessionId)?.team_id ??
      useCurrentTeamStore.getState().team?.id ??
      null;
    void preloadThreadForkMetadata(threadSessionId, parentTeamId);
  }, [isOpen, threadSessionId, parentSessionId]);

  const shouldExpand =
    isOpen &&
    !!rootMessageId &&
    !!composerSessionId &&
    storeParentSessionId === parentSessionId;

  const [mounted, setMounted] = React.useState(shouldExpand);
  const [expanded, setExpanded] = React.useState(false);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = React.useState(() =>
    readThreadPanelWidth({
      windowWidth: typeof window !== "undefined" ? window.innerWidth : undefined,
    }),
  );
  const [resizing, setResizing] = React.useState(false);
  const [resizeHint, setResizeHint] = React.useState(false);
  const panelWidthRef = React.useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  const resizeHintTimersRef = React.useRef<number[]>([]);

  const widthLimits = React.useCallback(() => {
    const row = shellRef.current?.parentElement?.clientWidth ?? 0;
    const windowWidth =
      typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : undefined;
    return {
      windowWidth,
      containerWidth: row > 0 ? row : undefined,
    };
  }, []);

  const handleResizeDelta = React.useCallback((deltaX: number) => {
    setPanelWidth((prev) => {
      const next = resizeThreadPanelWidth(prev, deltaX, widthLimits());
      panelWidthRef.current = next;
      return next;
    });
  }, [widthLimits]);

  const commitPanelWidth = React.useCallback(() => {
    setResizing(false);
    writeThreadPanelWidth(panelWidthRef.current, widthLimits());
  }, [widthLimits]);

  const resetPanelWidth = React.useCallback(() => {
    const next = writeThreadPanelWidth(THREAD_PANEL_WIDTH_DEFAULT, widthLimits());
    panelWidthRef.current = next;
    setPanelWidth(next);
    setResizing(false);
  }, [widthLimits]);

  React.useLayoutEffect(() => {
    if (!expanded) return;
    const fit = () => {
      const next = clampThreadPanelWidth(panelWidthRef.current, widthLimits());
      if (next === panelWidthRef.current) return;
      panelWidthRef.current = next;
      setPanelWidth(next);
      writeThreadPanelWidth(next);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [expanded, widthLimits]);

  const clearResizeHintTimers = React.useCallback(() => {
    for (const id of resizeHintTimersRef.current) window.clearTimeout(id);
    resizeHintTimersRef.current = [];
  }, []);

  const dismissResizeHint = React.useCallback(() => {
    clearResizeHintTimers();
    setResizeHint(false);
  }, [clearResizeHintTimers]);

  React.useEffect(() => {
    if (!expanded || hasSeenThreadPanelResizeHint()) return;
    const later = (ms: number, run: () => void) => {
      resizeHintTimersRef.current.push(window.setTimeout(run, ms));
    };
    later(THREAD_PANEL_MS, () => {
      markThreadPanelResizeHintSeen();
      setResizeHint(true);
    });
    later(THREAD_PANEL_MS + RESIZE_HINT_MS, () => setResizeHint(false));
    return () => clearResizeHintTimers();
  }, [expanded, clearResizeHintTimers]);

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
      if (!useThreadPanelStore.getState().isOpen) {
        useThreadPanelStore.getState().reset();
      }
    }, THREAD_PANEL_MS);
    return () => clearTimeout(timer);
  }, [shouldExpand]);

  if (!mounted) return null;

  return (
    <div
      ref={shellRef}
      data-testid="thread-panel-shell"
      className={cn(
        "relative z-30 h-full min-h-0 shrink-0",
        resizeHint ? "overflow-visible" : "overflow-hidden",
        resizing
          ? "transition-none"
          : "transition-[width] ease-out motion-reduce:transition-none",
      )}
      style={{
        width: expanded ? panelWidth : 0,
        transitionDuration: resizing ? "0ms" : `${THREAD_PANEL_MS}ms`,
      }}
    >
      <aside
        data-testid="thread-panel"
        className={cn(
          "relative flex h-full flex-col border-l border-border bg-background shadow-[-8px_0_24px_-12px_rgba(20,20,15,0.12)]",
          "transition-transform ease-out motion-reduce:transition-none",
          expanded ? "translate-x-0" : "translate-x-full",
        )}
        style={{
          width: panelWidth,
          transitionDuration: `${THREAD_PANEL_MS}ms`,
        }}
      >
      {expanded ? (
        <>
          <ThreadPanelResizeHandle
            width={panelWidth}
            maxWidth={threadPanelWidthMax(widthLimits())}
            hinting={resizeHint}
            onDragStart={() => {
              dismissResizeHint();
              setResizing(true);
            }}
            onDelta={handleResizeDelta}
            onCommit={commitPanelWidth}
            onReset={resetPanelWidth}
          />
          {resizeHint ? (
            <div
              data-testid="thread-panel-resize-hint"
              aria-hidden
              className="thread-resize-hint-grip pointer-events-none absolute left-0 top-1/2 z-40 text-foreground"
            >
              <svg width="22" height="18" viewBox="0 0 22 18" fill="none">
                <g stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 2.2v13.6" />
                  <path d="M7.4 9H2.2M2.2 9l2.3-2.3M2.2 9l2.3 2.3" />
                  <path d="M14.6 9h5.2M19.8 9l-2.3-2.3M19.8 9l-2.3 2.3" />
                </g>
                <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 2.2v13.6" />
                  <path d="M7.4 9H2.2M2.2 9l2.3-2.3M2.2 9l2.3 2.3" />
                  <path d="M14.6 9h5.2M19.8 9l-2.3-2.3M19.8 9l-2.3 2.3" />
                </g>
              </svg>
            </div>
          ) : null}
        </>
      ) : null}
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border-soft px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">
            {t("thread.headerTitle", { title: title ?? t("thread.defaultTitle") })}
          </div>
          <div className="mt-0.5 text-[11.5px] text-faint">{t("thread.headerSubtitle")}</div>
        </div>
        <button type="button" onClick={close} className="rounded p-1 text-faint hover:bg-selected">
          <X className="h-4 w-4" />
        </button>
      </header>

      {anchorSdk ? <ThreadAnchorPreview message={anchorSdk} /> : null}

      <SessionChatColumn
        sessionId={threadSessionId}
        parentSessionId={parentSessionId}
        composerSessionId={composerSessionId!}
        mentionSessionId={threadSessionId ?? parentSessionId}
        ensureSessionBeforeSend={wrappedEnsureSessionBeforeSend}
        compact
        inputLayout="inline"
        isolateComposerDraft
        suppressThreadBadge
        className="min-h-0 flex-1"
      />
      </aside>
    </div>
  );
}
