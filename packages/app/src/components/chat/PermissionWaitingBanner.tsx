import { useTranslation } from "react-i18next";
import { useActorDisplayName } from "@/hooks/use-actor-display-name";
import { cn } from "@/lib/utils";
import { composerGlassChildClass } from "./composer-glass";

/**
 * Read-only strip for collab bystanders while another member’s approval
 * is outstanding (Phase 2.5). No Allow / Deny / Always Allow.
 */
export function PermissionWaitingBanner({
  requesterActorId,
  appearance = "card",
  className,
}: {
  requesterActorId: string;
  appearance?: "card" | "glass";
  className?: string;
}) {
  const { t } = useTranslation();
  const resolvedName = useActorDisplayName(requesterActorId);
  const displayName =
    resolvedName?.trim() || requesterActorId.trim().slice(0, 8) || "…";

  return (
    <section
      data-testid="pending-permission-waiting"
      aria-live="polite"
      className={cn(
        "px-3.5 py-2.5",
        appearance === "glass"
          ? composerGlassChildClass
          : "border-t border-border-soft bg-gradient-to-b from-[#fffdfb] to-paper dark:from-card dark:to-card",
        className,
      )}
    >
      <p className="text-[12.5px] font-medium text-ink-2">
        {t("chat.permissionCard.waitingForApproval", "等待 {{name}} 批准", {
          name: displayName,
        })}
      </p>
    </section>
  );
}
