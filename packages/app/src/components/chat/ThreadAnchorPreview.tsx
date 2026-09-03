import { useTranslation } from "react-i18next";
import { useActorDisplayName } from "@/hooks/use-actor-display-name";
import { actorAvatarColor } from "@/lib/actor/actor-color";
import type { Message as StoreMessage } from "@/stores/session-types";

function anchorPreviewText(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= 160) return collapsed;
  return `${collapsed.slice(0, 160)}…`;
}

export function ThreadAnchorPreview({ message }: { message: StoreMessage }) {
  const { t } = useTranslation();
  const displayName = useActorDisplayName(message.senderActorId);
  const preview = anchorPreviewText(message.content);
  const colors = actorAvatarColor(message.senderActorId);
  const initial = (displayName || "A").slice(0, 1).toUpperCase();

  return (
    <div className="shrink-0 border-b border-border-soft bg-[#fbf9f4] px-3 py-2.5">
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
        {t("thread.anchorLabel")}
      </div>
      <div className="flex items-center gap-2">
        <div
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold"
          style={{ backgroundColor: colors.bg, color: colors.fg }}
        >
          {initial}
        </div>
        <span className="truncate text-[13px] font-semibold text-ink-2">
          {displayName || t("thread.agentFallback")}
        </span>
        <span className="shrink-0 rounded border border-coral/40 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-coral">
          AI
        </span>
      </div>
      {preview ? (
        <p className="mt-2 line-clamp-3 text-[12.5px] leading-[1.55] text-muted-foreground">
          {preview}
        </p>
      ) : null}
    </div>
  );
}
