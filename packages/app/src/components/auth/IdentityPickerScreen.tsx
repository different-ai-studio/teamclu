import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MyIdentity } from '@/lib/backend/types'

/**
 * Which org to enter, after a sign-in that named a person with identities in
 * more than one org (email / password / OAuth; phone login has its own account
 * picker). Each identity is its own account, so picking one swaps the session;
 * the team chooser that follows then lists that org's teams.
 * docs/plans/2026-10-08-staff-only-identity-model.md
 */
export function IdentityPickerScreen({
  identities,
  busy,
  error,
  onPick,
  onSignOut,
}: {
  identities: MyIdentity[]
  busy: boolean
  error: string | null
  onPick: (userId: string) => void
  onSignOut: () => void
}) {
  const { t } = useTranslation()
  const roleLabel = (adminType: number) =>
    adminType >= 3
      ? t('auth.identityPicker.superAdmin', '超级管理员')
      : adminType === 2
        ? t('auth.identityPicker.admin', '管理员')
        : null

  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-[440px] rounded-[16px] border border-border bg-paper p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-foreground">
          {t('auth.identityPicker.title', '选择要进入的组织')}
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          {t('auth.identityPicker.subtitle', '你在多个组织中都有身份，选择这次要进入哪一个。')}
        </p>

        <div className="mt-4 space-y-2">
          {identities.map((identity) => {
            const role = roleLabel(identity.adminType)
            return (
              <button
                key={identity.userId}
                type="button"
                disabled={busy}
                onClick={() => onPick(identity.userId)}
                className="flex w-full items-center justify-between rounded-[10px] border border-border bg-selected/30 px-4 py-3 text-left transition-colors hover:bg-selected/60 disabled:opacity-50"
              >
                <span className="flex flex-col">
                  <span className="text-[14px] font-medium text-foreground">
                    {identity.orgName || t('auth.identityPicker.unnamedOrg', '未命名组织')}
                  </span>
                  {role ? <span className="text-[12px] text-muted-foreground">{role}</span> : null}
                </span>
                {identity.isCurrent ? (
                  <span className="text-[11.5px] text-muted-foreground">
                    {t('auth.identityPicker.current', '当前账号')}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        {busy ? (
          <p className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('auth.identityPicker.switching', '正在切换…')}
          </p>
        ) : null}
        {error ? <p className="mt-2 text-[12px] leading-5 text-destructive">{error}</p> : null}

        <button
          type="button"
          onClick={onSignOut}
          disabled={busy}
          className="mt-5 w-full text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t('auth.teamBootstrapError.signOut', '退出登录并使用其他账号')}
        </button>
      </div>
    </div>
  )
}
