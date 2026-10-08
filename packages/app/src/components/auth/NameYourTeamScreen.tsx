import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Matches the server's own guard — an empty org name raises 23514. */
const MAX_NAME_LENGTH = 60

/**
 * First-run naming, shown once a signed-in account turns out to have no team.
 *
 * The name is required and starts empty: it names the new tenant (org and
 * team alike), whose creator becomes its super admin
 * (docs/plans/2026-10-08-staff-only-identity-model.md). A derived default named
 * a company's workspace after whoever happened to sign up first. The server
 * still derives one for older clients that send none.
 *
 * One field, two readings: a company name for a team that has one, the name of
 * your own small team if not. It sets the org and the team together, which is
 * the invariant the login redesign established
 * (docs/plans/2026-08-17-login-org-team-redesign.md).
 */
export function NameYourTeamScreen({
  busy,
  error,
  onSubmit,
  onSignOut,
}: {
  busy: boolean
  error: string | null
  onSubmit: (name: string) => void
  onSignOut: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !busy

  const submit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <form
        className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h1 className="text-[16px] font-semibold text-foreground">
          {t('auth.nameYourTeam.title', '给你的团队起个名字')}
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          {t(
            'auth.nameYourTeam.subtitle',
            '公司名，或者你自己小队的名字。之后可以在设置里改。',
          )}
        </p>

        <Input
          value={name}
          maxLength={MAX_NAME_LENGTH}
          disabled={busy}
          autoFocus
          aria-label={t('auth.nameYourTeam.title', '给你的团队起个名字')}
          placeholder={t('auth.nameYourTeam.placeholder', '例如：倍拓科技')}
          onChange={(e) => setName(e.target.value)}
          className="mt-4 h-10 rounded-[10px]"
        />

        {error ? (
          <p className="mt-2 text-[12px] leading-5 text-destructive">{error}</p>
        ) : null}

        <div className="mt-5 flex flex-col gap-4">
          <Button
            type="submit"
            className="h-10 w-full rounded-[10px] bg-coral text-coral-foreground hover:opacity-90"
            disabled={!canSubmit}
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('auth.nameYourTeam.creating', '正在创建…')}
              </span>
            ) : (
              t('auth.nameYourTeam.continue', '继续')
            )}
          </Button>
          <button
            type="button"
            onClick={onSignOut}
            disabled={busy}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {t('auth.teamBootstrapError.signOut', '退出登录并使用其他账号')}
          </button>
        </div>
      </form>
    </div>
  )
}
