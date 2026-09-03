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
import { useInviteLinkConfirmation } from "@/lib/invite-link-confirmation";
import { truncatePermissionSnippet } from "@/lib/utils";

/**
 * SEC-3: the gate between an invite link arriving and the team being joined.
 *
 * Mounted once at the root (main.tsx), outside AuthGate, so it is available on
 * the login screen as well as inside the shell — a link can arrive in either
 * state. The token path never had a confirmation before: opening a link joined
 * the team, switched the active org, and re-onboarded the daemon in one go.
 *
 * There is no invite preview endpoint (the token is only readable server-side
 * on claim), so the dialog cannot name the team. It says what accepting does
 * and shows a fingerprint of the token, which is what the user can match
 * against the link they were sent.
 */
export function InviteLinkConfirmDialog() {
  const { t } = useTranslation();
  const requested = useInviteLinkConfirmation((s) => s.requested);
  const accept = useInviteLinkConfirmation((s) => s.accept);
  const dismiss = useInviteLinkConfirmation((s) => s.dismiss);
  const signedIn = useAuthStore((s) => !!s.session);

  const open = requested !== null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("inviteLink.title", "Join a team from this invite link?")}</DialogTitle>
          <DialogDescription>
            {t(
              "inviteLink.description",
              "Accepting joins the team this link belongs to, switches your active organization, and re-binds the local agent to that team. Continue only if you trust whoever sent it.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm">
          <div className="text-xs text-muted-foreground">{t("inviteLink.tokenLabel", "Invite token")}</div>
          <code className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs break-all">
            {requested ? truncatePermissionSnippet(requested, 24) : ""}
          </code>
          {!signedIn && (
            <div className="text-xs text-muted-foreground">
              {t("inviteLink.signInFirst", "You'll sign in first; the invite is claimed right after.")}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            {t("inviteLink.cancel", "Not now")}
          </Button>
          <Button onClick={accept}>{t("inviteLink.accept", "Join team")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
