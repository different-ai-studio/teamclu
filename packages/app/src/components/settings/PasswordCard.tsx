import { useState } from "react"
import { useTranslation } from "react-i18next"
import { KeyRound } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getBackend } from "@/lib/backend"
import { validateNewPassword, type NewPasswordIssue } from "@/lib/auth/password"
import { useAuthStore } from "@/stores/auth-store"
import { SettingCard } from "./shared"

const ISSUE_KEYS: Record<Exclude<NewPasswordIssue, "empty">, [string, string]> = {
  too_short: ["settings.general.passwordTooShort", "Use at least 8 characters"],
  too_long: ["settings.general.passwordTooLong", "Use at most 72 characters"],
  mismatch: ["settings.general.passwordMismatch", "The two passwords do not match"],
}

/**
 * Set or change the signed-in account password. One form for both: the
 * current session is the proof, so the previous password is not asked for.
 */
export function PasswordCard() {
  const { t } = useTranslation()
  const session = useAuthStore((s) => s.session)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  if (!session) return null

  const onSave = async () => {
    const issue = validateNewPassword(password, confirm)
    if (issue === "empty") return
    if (issue) {
      const [key, fallback] = ISSUE_KEYS[issue]
      setError(t(key, fallback))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await getBackend().auth.updatePassword(password)
      setPassword("")
      setConfirm("")
      toast.success(t("settings.general.passwordSaved", "Password saved"))
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : ""
      setError(message || t("settings.general.passwordFailed", "Could not save the password. Try again."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingCard>
      <div className="space-y-2">
        <label className="text-[13px] font-medium flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          {t("settings.general.passwordTitle", "Password")}
        </label>
        <p className="text-xs text-muted-foreground">
          {t(
            "settings.general.passwordDesc",
            "Set or change the password for this account. After saving, you can sign in on the phone app with your email and this password.",
          )}
        </p>
        <div className="space-y-2">
          <label className="block space-y-1.5" htmlFor="account-new-password">
            <span className="block text-[12px] font-medium text-ink-2">
              {t("settings.general.newPassword", "New password")}
            </span>
            <Input
              id="account-new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={saving}
              className="h-11"
              data-testid="account-new-password"
            />
          </label>
          <label className="block space-y-1.5" htmlFor="account-confirm-password">
            <span className="block text-[12px] font-medium text-ink-2">
              {t("settings.general.confirmPassword", "Confirm new password")}
            </span>
            <Input
              id="account-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSave()
              }}
              disabled={saving}
              className="h-11"
              data-testid="account-confirm-password"
            />
          </label>
        </div>
        {error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={() => void onSave()}
          disabled={saving || password.length === 0 || confirm.length === 0}
          className="h-11"
        >
          {saving
            ? t("settings.general.passwordSaving", "Saving…")
            : t("settings.general.save", "Save")}
        </Button>
      </div>
    </SettingCard>
  )
}
