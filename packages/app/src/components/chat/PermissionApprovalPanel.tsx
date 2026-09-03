import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { composerGlassChildClass } from "./composer-glass";
import { useSessionStore } from "@/stores/session-store";
import type { PendingPermissionEntry } from "@/stores/session-types";
import {
  getPermissionCardPresentation,
  type PermissionTranslateFn,
} from "./permission-presentation";

export function PermissionApprovalPanel({
  entry,
  queueIndex,
  queueTotal,
  onReplyStart,
  onReplyRollback,
  appearance = "card",
  className,
}: {
  entry: PendingPermissionEntry;
  queueIndex: number;
  queueTotal: number;
  onReplyStart?: (permissionId: string) => void;
  onReplyRollback?: (permissionId: string) => void;
  /** `glass`: embedded row inside the composer chrome block. */
  appearance?: "card" | "glass";
  className?: string;
}) {
  const { t: i18nT } = useTranslation();
  const t = React.useCallback<PermissionTranslateFn>(
    (key, fallback, options) =>
      (i18nT as unknown as PermissionTranslateFn)(key, fallback, options),
    [i18nT],
  );
  const replyPermission = useSessionStore((s) => s.replyPermission);
  const [submitting, setSubmitting] = React.useState(false);

  const { meta, detail, subtitle } = getPermissionCardPresentation(entry, t);

  const handleReply = async (d: "allow" | "deny" | "always") => {
    setSubmitting(true);
    onReplyStart?.(entry.permission.id);
    try {
      await replyPermission(entry.permission.id, d);
    } catch {
      onReplyRollback?.(entry.permission.id);
      throw new Error("permission reply failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      data-testid="pending-permission-card"
      aria-label={t("chat.permissionCard.approvalSectionAria", "Permission approval")}
      className={cn(
        "px-3.5 py-3",
        appearance === "glass"
          ? composerGlassChildClass
          : "border-t border-border-soft bg-gradient-to-b from-[#fffdfb] to-paper dark:from-card dark:to-card",
        className,
      )}
    >
      {queueTotal > 1 ? (
        <div className="mb-2 flex justify-end">
          <span
            data-testid="pending-permission-queue"
            className="font-mono text-[10.5px] text-faint"
          >
            {t("chat.permissionCard.queuePosition", "{{current}} / {{total}}", {
              current: queueIndex + 1,
              total: queueTotal,
            })}
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background font-mono text-[13px] text-muted-foreground"
          aria-hidden
        >
          {meta.glyph}
        </div>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-snug text-foreground">
            {meta.subject} {meta.title}
          </h3>
          <p
            className="mt-1 font-mono text-[11.5px] leading-relaxed text-ink-2 break-all"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {detail}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-faint">{subtitle}</p>
        </div>
        <div
          data-testid="pending-permission-actions"
          className="flex shrink-0 flex-col gap-1.5"
        >
          <button
            type="button"
            onClick={() => void handleReply("allow")}
            disabled={submitting}
            className="w-full rounded-lg bg-foreground px-3 py-1.5 text-center text-[12px] font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {t("chat.permissionCard.approve", "Allow")}
          </button>
          <button
            type="button"
            onClick={() => void handleReply("always")}
            disabled={submitting}
            className="w-full rounded-lg border border-border bg-paper px-3 py-1.5 text-center text-[12px] font-medium text-ink-2 transition-colors hover:bg-panel disabled:opacity-50"
          >
            {t("permission.alwaysAllow", "Always allow")}
          </button>
          <button
            type="button"
            onClick={() => void handleReply("deny")}
            disabled={submitting}
            className="w-full rounded-lg px-3 py-1.5 text-center text-[12px] font-medium text-muted-foreground transition-colors hover:bg-panel hover:text-foreground disabled:opacity-50"
          >
            {t("permission.deny", "Deny")}
          </button>
        </div>
      </div>
    </section>
  );
}
