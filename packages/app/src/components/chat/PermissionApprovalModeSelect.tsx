import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Hand, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { flushSessionPendingPermissions } from "@/lib/teamclu/flush-session-pending-permissions";
import {
  setSessionPermissionMode,
  useSessionPermissionMode,
  type SessionPermissionMode,
} from "@/lib/session-permission-mode";
import { isSoloBuild } from "@/lib/solo-build";
import { PromptInputButton } from "@/packages/ai/prompt-input-ui";

type PermissionApprovalModeSelectProps = {
  sessionId: string | null;
  /** Icon-only trigger for narrow composers (thread panel). */
  iconOnly?: boolean;
};

export function PermissionApprovalModeSelect({
  sessionId,
  iconOnly = false,
}: PermissionApprovalModeSelectProps) {
  const { t } = useTranslation();
  const mode = useSessionPermissionMode(sessionId);

  // Internal extension builds hide permission controls entirely.
  if (isSoloBuild()) return null;
  if (!sessionId) return null;

  const handleSelect = (next: SessionPermissionMode) => {
    if (next === mode) return;
    setSessionPermissionMode(sessionId, next);
    if (next === "fullAccess") {
      void flushSessionPendingPermissions(sessionId);
    }
  };

  const label =
    mode === "fullAccess"
      ? t("chat.permissionMode.fullAccess", "完全访问权限")
      : t("chat.permissionMode.default", "默认权限");

  const Icon = mode === "fullAccess" ? Info : Hand;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PromptInputButton
          type="button"
          className={cn(
            "h-8 shrink-0 text-muted-foreground",
            iconOnly ? "w-8 px-0" : "gap-1 px-2 text-[12px]",
          )}
          data-testid="permission-approval-mode-trigger"
          title={label}
          aria-label={label}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {!iconOnly ? (
            <>
              <span className="max-w-[7rem] truncate">{label}</span>
              <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
            </>
          ) : null}
        </PromptInputButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        <DropdownMenuItem
          className="flex items-center gap-2 text-[13px]"
          data-testid="permission-mode-default"
          onSelect={() => handleSelect("default")}
        >
          <Hand className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t("chat.permissionMode.default", "默认权限")}</span>
          {mode === "default" ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="flex items-center gap-2 text-[13px]"
          data-testid="permission-mode-full-access"
          onSelect={() => handleSelect("fullAccess")}
        >
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1">{t("chat.permissionMode.fullAccess", "完全访问权限")}</span>
          {mode === "fullAccess" ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
