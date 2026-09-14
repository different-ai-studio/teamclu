import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usesStoredHttpsCredential } from '@/lib/apps/app-list-helpers'
import { useAppsStore } from '@/stores/apps-store'
import type { AppRow } from '@/lib/backend/types'

/**
 * The token git uses for an imported repo reached over http(s): whether one is
 * stored, and a way to set, replace or clear it.
 *
 * The value is never shown or read back. No endpoint returns it to a person —
 * only to the machines that clone — so "replace" means typing a new one, the
 * same bargain a secret environment variable makes.
 */
export function AppGitCredentialControl({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const saveGitCredential = useAppsStore((s) => s.saveGitCredential)
  const clearGitCredential = useAppsStore((s) => s.clearGitCredential)
  const stored = usesStoredHttpsCredential(app)

  const [editing, setEditing] = React.useState(false)
  const [confirmingClear, setConfirmingClear] = React.useState(false)
  const [username, setUsername] = React.useState('')
  const [token, setToken] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const closeForm = () => {
    setEditing(false)
    setUsername('')
    setToken('')
  }

  const save = async () => {
    if (!token.trim()) return
    setBusy(true)
    try {
      const ok = await saveGitCredential(app.id, { username: username.trim(), token: token.trim() })
      if (ok) {
        closeForm()
        toast.success(t('apps.gitCredential.saved', '凭证已保存'))
      }
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    try {
      const ok = await clearGitCredential(app.id)
      if (ok) {
        setConfirmingClear(false)
        toast.success(t('apps.gitCredential.cleared', '凭证已清除'))
      }
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <form
        className="space-y-2"
        data-testid="app-settings-git-credential-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="grid max-w-[520px] gap-1.5 @[560px]:grid-cols-2">
          <Input
            aria-label={t('apps.repoUsernameLabel', '用户名')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('apps.repoUsernamePlaceholder', '用户名（GitHub、GitLab 可留空）')}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-9 rounded-[7px] text-[13px]"
          />
          <Input
            type="password"
            aria-label={t('apps.repoTokenLabel', '访问令牌')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('apps.repoTokenPlaceholder', '访问令牌（Personal Access Token）')}
            disabled={busy}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            className="h-9 rounded-[7px] text-[13px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="submit"
            size="sm"
            className="h-8 gap-1.5 rounded-[7px] text-[12px]"
            disabled={busy || !token.trim()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('apps.gitCredential.save', '保存')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-[7px] text-[12px]"
            onClick={closeForm}
            disabled={busy}
          >
            {t('apps.gitCredential.cancel', '取消')}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p
        className="flex items-center gap-1.5 text-[13px] text-foreground"
        data-testid="app-settings-git-credential-status"
      >
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
        {stored
          ? t('apps.gitCredential.stored', '已保存')
          : t('apps.gitCredential.none', '未设置')}
      </p>
      {confirmingClear ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 rounded-[7px] text-[12px] text-destructive"
            disabled={busy}
            onClick={() => void clear()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t('apps.gitCredential.confirmClear', '确认清除')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-[7px] text-[12px]"
            disabled={busy}
            onClick={() => setConfirmingClear(false)}
          >
            {t('apps.gitCredential.cancel', '取消')}
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-[7px] text-[12px]"
            onClick={() => setEditing(true)}
          >
            {stored
              ? t('apps.gitCredential.replace', '更换')
              : t('apps.gitCredential.set', '设置')}
          </Button>
          {stored && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 rounded-[7px] text-[12px] text-muted-foreground"
              onClick={() => setConfirmingClear(true)}
            >
              {t('apps.gitCredential.clear', '清除')}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
