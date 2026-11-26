import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { getBackend } from '@/lib/backend'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import type { OrgSsoStatus } from '@/lib/backend/cloud-api/org-sso'
import { openExternalUrl } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { WecomIcon } from '@/components/auth/oauth-icons'
import { SettingCard } from './shared'

/**
 * Connect the org to its WeCom company — Settings「团队管理」→ 组织角色.
 *
 * Connecting opens WeCom's install page in the browser; a WeCom admin of the
 * company installs the TeamClu app there, which binds the company to this org.
 * After that, the company's members can scan in and land in this org as
 * members. Org owner/admin only (the server enforces it; a 403 hides the card).
 */
export function EnterpriseSsoCard({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<OrgSsoStatus | null>(null)
  const [hidden, setHidden] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [waiting, setWaiting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      setStatus(await getBackend().orgSso.status(teamId, 'wecom'))
      setError(null)
    } catch (e) {
      if (e instanceof CloudApiError && (e.status === 403 || e.status === 404 || e.status === 501)) {
        setHidden(true)
        return
      }
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [teamId])

  React.useEffect(() => {
    void load()
  }, [load])

  // The install finishes in the browser; re-check when the window regains focus.
  React.useEffect(() => {
    if (!waiting) return
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [waiting, load])

  React.useEffect(() => {
    if (status?.binding) setWaiting(false)
  }, [status?.binding])

  if (hidden || (status && !status.configured)) return null

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const url = await getBackend().orgSso.installUrl(teamId, 'wecom')
      await openExternalUrl(url)
      setWaiting(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!window.confirm(t('settings.enterpriseSso.confirmDisconnect', '断开后，该企业的成员将无法再用企业微信扫码登录。已有账号保留。确定断开？'))) return
    setBusy(true)
    setError(null)
    try {
      await getBackend().orgSso.disconnect(teamId, 'wecom')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const binding = status?.binding ?? null

  return (
    <SettingCard>
      <div className="flex items-start gap-3">
        <WecomIcon className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[13px] font-semibold">{t('settings.enterpriseSso.title', '企业微信登录')}</p>
          {!status ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : binding ? (
            <p className="text-[12.5px] text-muted-foreground">
              {t('settings.enterpriseSso.connected', '已连接 {{name}}。企业成员可以用企业微信扫码登录，首次登录会自动加入本组织。', {
                name: binding.tenantName ?? binding.tenantId,
              })}
            </p>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              {waiting
                ? t('settings.enterpriseSso.waiting', '请在浏览器中由企业微信管理员完成安装授权，完成后回到这里。')
                : t('settings.enterpriseSso.description', '连接你的企业微信企业后，成员可以扫码登录 TeamClu 并自动加入本组织。需要企业微信管理员在浏览器中安装授权。')}
            </p>
          )}
          {error && (
            <p className="text-[12.5px] text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        {status && (
          <Button
            size="sm"
            variant={binding ? 'outline' : 'default'}
            className={binding ? 'shrink-0' : 'shrink-0 bg-coral text-white hover:bg-coral/90'}
            disabled={busy}
            onClick={() => void (binding ? disconnect() : connect())}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {binding
              ? t('settings.enterpriseSso.disconnect', '断开')
              : t('settings.enterpriseSso.connect', '连接企业微信')}
          </Button>
        )}
      </div>
    </SettingCard>
  )
}
