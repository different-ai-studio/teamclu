import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useJoinLinkConfirmation } from "@/lib/team/join-link-confirmation";
import {
  JoinLinkHttpError,
  joinLinkGoneMessage,
  previewJoinLink,
  redeemAcceptedJoinLinkOnce,
  resolveJoinLinkOrigin,
  type JoinLinkPreview,
} from "@/lib/team/join-link";
import { getFreshAccessToken } from "@/lib/auth/session-store";

export function JoinLinkConfirmDialog() {
  const { t } = useTranslation();
  const requested = useJoinLinkConfirmation((s) => s.requested);
  const accept = useJoinLinkConfirmation((s) => s.accept);
  const dismiss = useJoinLinkConfirmation((s) => s.dismiss);
  const signedIn = useAuthStore((s) => !!s.session);
  const [preview, setPreview] = useState<JoinLinkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = requested !== null;
  const origin = requested ? resolveJoinLinkOrigin(requested.cloudApiUrl) : null;

  useEffect(() => {
    if (!requested || !origin) {
      setPreview(null);
      setError(requested && !origin ? t("joinLink.noServer", "Cloud API URL is not configured.") : null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setError(null);
    void previewJoinLink(origin, requested.token)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (cancelled) return;
        const code = err instanceof JoinLinkHttpError ? err.code : null;
        setError(joinLinkGoneMessage(code) ?? t("joinLink.previewFailed", "Could not load this join link."));
      });
    return () => {
      cancelled = true;
    };
  }, [requested, origin, t]);

  const onAccept = () => {
    if (!requested) return;
    if (!signedIn) {
      accept();
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const accessToken = await getFreshAccessToken();
        await redeemAcceptedJoinLinkOnce(requested, accessToken);
        accept();
      } catch (err) {
        const code = err instanceof JoinLinkHttpError ? err.code : null;
        setError(joinLinkGoneMessage(code) ?? t("joinLink.joinFailed", "Could not join this team."));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("joinLink.title", "Join this team?")}</DialogTitle>
          <DialogDescription>
            {t(
              "joinLink.description",
              "Accepting adds you as a member of this team. The local agent stays bound to the team it already has.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm">
          {preview && (
            <>
              <div className="text-[13px] font-medium text-foreground">{preview.teamName}</div>
              <div className="text-[12px] text-muted-foreground">{preview.inviterDisplayName}</div>
            </>
          )}
          {error && <div className="text-[12px] text-destructive">{error}</div>}
          {!signedIn && !error && (
            <div className="text-xs text-muted-foreground">
              {t("joinLink.signInFirst", "You'll sign in first; the team is joined right after.")}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={dismiss} disabled={busy}>
            {t("joinLink.cancel", "Not now")}
          </Button>
          <Button onClick={onAccept} disabled={busy || !preview || !!error}>
            {t("joinLink.accept", "Join team")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
