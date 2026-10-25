import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  registerDeployConfirmHandler,
  type DeployConfirmPrompt,
} from "@/lib/apps/app-deploy-confirm";

type PendingPrompt = DeployConfirmPrompt & {
  resolve: (accepted: boolean) => void;
};

/**
 * Imperative deploy checkpoints (public access, active agent turn) must not use
 * `window.confirm` — Tauri's WebView often drops it and returns false, which
 * made deploy look like a no-op.
 */
export function AppDeployConfirmDialog() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const [switchDomain, setSwitchDomain] = useState(false);

  useEffect(() => {
    registerDeployConfirmHandler((prompt) =>
      new Promise<boolean>((resolve) => {
        setSwitchDomain(false);
        const next = { ...prompt, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    );
    return () => {
      registerDeployConfirmHandler(null);
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const close = useCallback((accepted: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    if (accepted && current.domainChoice) current.onDomainChoice?.(switchDomain);
    current.resolve(accepted);
  }, [switchDomain]);

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
    >
      <AlertDialogContent size="sm" className="max-w-[400px]" data-testid="app-deploy-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("apps.deployConfirmTitle", "确认部署")}
          </AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap text-[13px] leading-relaxed">
            {pending?.message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pending?.domainChoice && (
          <label className="flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={switchDomain}
              onChange={(event) => setSwitchDomain(event.target.checked)}
              className="mt-1 accent-foreground"
            />
            <span>
              {t("apps.deployDomainSwitch", "部署成功后，改用应用代码域名")}
              <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
                {pending.domainChoice.codeUrl}
              </span>
              <span className="mt-1 block text-[11.5px] text-muted-foreground">
                {t("apps.deployDomainKeepHint", "默认保留当前域名；勾选切换后，原域名仍可访问。")}
              </span>
              <span className="block break-all font-mono text-[11px] text-faint">
                {pending.domainChoice.currentUrl}
              </span>
            </span>
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>
            {t("common.cancel", "取消")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => close(true)}>
            {t("apps.deployConfirmContinue", "继续部署")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
