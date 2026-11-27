import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isSsoPlaceholderEmail, isSsoPlaceholderName } from "@/lib/auth/sso-identity";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore } from "@/stores/current-team";

/**
 * Asks someone who signed in with WeCom (or another enterprise IdP) for a
 * display name. The provider does not share real names with third-party apps,
 * so the account starts as "企业微信用户 xxxx". Shown while that fallback name
 * is still in place; "Later" hides it until the next launch.
 */
export function SsoNamePrompt() {
  const { t } = useTranslation();
  const email = useAuthStore((s) => s.session?.user.email ?? null);
  const member = useCurrentTeamStore((s) => s.currentMember);
  const saving = useCurrentTeamStore((s) => s.saving);
  const renameCurrentMember = useCurrentTeamStore((s) => s.renameCurrentMember);
  const [dismissed, setDismissed] = React.useState(false);
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const needsName =
    !!member && isSsoPlaceholderEmail(email) && isSsoPlaceholderName(member.displayName);
  const open = needsName && !dismissed;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    const ok = await renameCurrentMember(trimmed);
    if (!ok) {
      setError(useCurrentTeamStore.getState().error || t("auth.ssoNamePrompt.failed", "Could not save your name. Try again."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setDismissed(true); }}>
      <DialogContent className="sm:max-w-sm" data-testid="sso-name-prompt">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("auth.ssoNamePrompt.title", "What should your team call you?")}</DialogTitle>
            <DialogDescription>
              {t(
                "auth.ssoNamePrompt.description",
                "WeCom doesn't share your name with TeamClu. Enter the name your teammates know you by; you can change it later in your profile.",
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            maxLength={64}
            placeholder={t("auth.ssoNamePrompt.placeholder", "Your name")}
            onChange={(e) => setName(e.target.value)}
            data-testid="sso-name-input"
          />
          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDismissed(true)}>
              {t("auth.ssoNamePrompt.later", "Later")}
            </Button>
            <Button type="submit" disabled={!name.trim() || saving} data-testid="sso-name-save">
              {t("common.save", "Save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
