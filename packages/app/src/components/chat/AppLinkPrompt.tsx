import * as React from "react";
import { useTranslation } from "react-i18next";
import { AppWindow } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { detectCreatedAppInMessage } from "@/lib/apps/app-create-detect";
import { linkSessionToApp } from "@/lib/apps/link-session-app";
import { useSessionListStore } from "@/stores/session-list-store";
import type { Message } from "@/stores/session-types";

const DISMISS_KEY_PREFIX = "teamclu.appLinkPrompt.dismissed.";

function readDismissed(sessionId: string): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY_PREFIX + sessionId) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(sessionId: string): void {
  try {
    localStorage.setItem(DISMISS_KEY_PREFIX + sessionId, "1");
  } catch {
    // Not remembered on this device; the session keeps no other state for it.
  }
}

/**
 * Offers to link the session to the app an agent just created in it (#1885).
 *
 * Shown under a finished agent message whose `amuxd app create` succeeded,
 * only for a regular session that has no app yet. "Not now" is remembered per
 * session on this device and not asked again there. Once linked, the session
 * row carries the app id and the prompt goes away by itself.
 */
export function AppLinkPrompt({ message }: { message: Pick<Message, "sessionId" | "parts" | "toolCalls"> }) {
  const { t } = useTranslation();
  const created = React.useMemo(
    () => detectCreatedAppInMessage(message),
    [message],
  );
  const sessionId = message.sessionId;
  const linkable = useSessionListStore((s) => {
    const row = s.rows.find((r) => r.id === sessionId);
    return !!row && !row.app_id && (row.source ?? "user") === "user";
  });
  const [dismissed, setDismissed] = React.useState(() => readDismissed(sessionId));
  const [linking, setLinking] = React.useState(false);

  if (!created || !linkable || dismissed) return null;

  const handleLink = async () => {
    setLinking(true);
    try {
      await linkSessionToApp(sessionId, created.appId);
      toast.success(t("chat.appLink.linked", "已关联到应用「{{name}}」", { name: created.appName }));
    } catch (e) {
      toast.error(
        t("chat.appLink.failed", "关联失败：{{message}}", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setLinking(false);
    }
  };

  const handleDismiss = () => {
    writeDismissed(sessionId);
    setDismissed(true);
  };

  return (
    <div
      data-testid="app-link-prompt"
      className="mt-2 ml-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-[13px]"
    >
      <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-foreground/85">
        {t(
          "chat.appLink.prompt",
          "已创建应用「{{name}}」。要把当前会话关联到这个应用吗？关联后会话会出现在应用下，文件树切到应用目录。",
          { name: created.appName },
        )}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          onClick={handleDismiss}
          disabled={linking}
          data-testid="app-link-prompt-dismiss"
        >
          {t("chat.appLink.dismiss", "不用")}
        </Button>
        <Button
          size="xs"
          onClick={handleLink}
          disabled={linking}
          data-testid="app-link-prompt-link"
        >
          {linking ? t("chat.appLink.linking", "关联中…") : t("chat.appLink.link", "关联")}
        </Button>
      </div>
    </div>
  );
}
