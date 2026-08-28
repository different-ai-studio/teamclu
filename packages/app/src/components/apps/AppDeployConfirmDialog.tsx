import { useCallback, useEffect, useState } from "react";
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
} from "@/lib/app-deploy-confirm";

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

  useEffect(() => {
    registerDeployConfirmHandler(({ message }) =>
      new Promise<boolean>((resolve) => {
        setPending({ message, resolve });
      }),
    );
    return () => registerDeployConfirmHandler(null);
  }, []);

  const close = useCallback((accepted: boolean) => {
    setPending((current) => {
      current?.resolve(accepted);
      return null;
    });
  }, []);

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
