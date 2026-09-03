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

const EMPTY_PROTO_MESSAGES: ProtoMessage[] = [];
const THREAD_PANEL_WIDTH_PX = 380;
const THREAD_PANEL_MS = 300;

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
      data-testid="thread-panel-shell"
      className={cn(
        "relative z-30 h-full min-h-0 shrink-0 overflow-hidden",
        "transition-[width] duration-300 ease-out motion-reduce:transition-none",
        expanded ? "w-[380px]" : "w-0",
      )}
      style={{ transitionDuration: `${THREAD_PANEL_MS}ms` }}
    >
      <aside
        data-testid="thread-panel"
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
