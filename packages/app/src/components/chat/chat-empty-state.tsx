import * as React from "react";
import type { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { DraftActor } from "@/stores/ui";
import { quickChatWelcomeAgent } from "@/hooks/use-quick-chat-readiness";
import { LocalAgentWelcomeEmptyState } from "./LocalAgentWelcomeEmptyState";
import { SessionEmptyThreadState } from "./SessionEmptyThreadState";
import { SessionContinueBanner } from "./SessionContinueBanner";

interface ChatEmptyStateProps {
  activeSessionId: string | null;
  compact: boolean;
  t: ReturnType<typeof useTranslation>["t"];
  draftPreselectedActor: DraftActor | null;
  welcomeQuickChatAgent: ReturnType<typeof quickChatWelcomeAgent>["agent"];
  welcomeQuickChatLoading: boolean;
  welcomeSessionStarting: boolean;
  handleStartLocalAgentSession: () => void;
  handleLocalAgentQuickAction: (message: string) => void;
  handleOpenAgentSettings: () => void;
}

/**
 * What the message thread shows when it has no messages: the per-session empty
 * thread, the "you picked an actor, now type" draft hint, or the local-agent
 * welcome card.
 *
 * Deliberately a plain function rather than a component. `MessageList` treats
 * `emptyState === null` as "render nothing at all" and `emptyState !== null`
 * as "center an empty-state block", so the null returns below are load-bearing
 * — a component would always hand back a non-null element and silently turn
 * every one of them into a centered empty block.
 *
 * Keep the call inside `React.useMemo`: `MessageList` receives the result as
 * a prop, and a fresh node on every render would defeat its memoization.
 */
export function renderChatEmptyState({
  activeSessionId,
  compact,
  t,
  draftPreselectedActor,
  welcomeQuickChatAgent,
  welcomeQuickChatLoading,
  welcomeSessionStarting,
  handleStartLocalAgentSession,
  handleLocalAgentQuickAction,
  handleOpenAgentSettings,
}: ChatEmptyStateProps): React.ReactNode {
  if (activeSessionId) {
    if (compact) {
      return null;
    }
    return (
      <SessionEmptyThreadState
        sessionId={activeSessionId}
      />
    );
  }
  if (draftPreselectedActor) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center text-center",
          compact ? "py-8 px-2" : "py-20",
        )}
      >
        <h2
          className={cn(
            "mb-1 font-semibold",
            compact ? "text-sm" : "text-xl",
          )}
        >
          {draftPreselectedActor.displayName}
        </h2>
        <p
          className={cn(
            "text-muted-foreground",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {draftPreselectedActor.kind === 'agent'
            ? t('chat.draftWithAgentHint', '在下方输入消息，发送后创建与该 Agent 的会话')
            : t('chat.draftWithMemberHint', '在下方输入消息，发送后创建与该成员的会话')}
        </p>
        <SessionContinueBanner
          actorId={draftPreselectedActor.id}
          actorName={draftPreselectedActor.displayName}
        />
      </div>
    );
  }
  // Creating the first session from welcome/draft — keep the thread blank
  // instead of flashing the "… is waiting on this device" welcome card.
  if (welcomeSessionStarting) {
    return null;
  }
  if (!compact) {
    return (
      <LocalAgentWelcomeEmptyState
        agent={welcomeQuickChatAgent}
        agentLoading={welcomeQuickChatLoading}
        starting={welcomeSessionStarting}
        onStartConversation={() => void handleStartLocalAgentSession()}
        onQuickAction={(message) => void handleLocalAgentQuickAction(message)}
        onOpenAgentSettings={handleOpenAgentSettings}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        "py-8 px-2",
      )}
    >
      <h2 className="mb-1 text-sm font-semibold">
        {welcomeQuickChatAgent?.displayName ?? t("chat.agent", "Agent")}
      </h2>
      <p className="text-xs text-muted-foreground">
        {t("chat.askAboutFile", "Ask questions about the file")}
      </p>
    </div>
  );
}
