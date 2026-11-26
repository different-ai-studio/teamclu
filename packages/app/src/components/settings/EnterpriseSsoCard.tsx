import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { getBackend } from '@/lib/backend'
import { CloudApiError } from '@/lib/backend/cloud-api/http'
import type { OrgSsoDirectory, OrgSsoStatus } from '@/lib/backend/cloud-api/org-sso'
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
 *
 * Once connected, an optional second step gets real member names: WeCom gives
 * the sign-in app none, so a WeCom admin scans a QR to authorize TeamClu's
 * 代开发 app (docs/specs/2026-11-26-wecom-customized-app-names.md).
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
      {binding && status?.directoryConfigured ? (
        <DirectoryNamesSection teamId={teamId} directory={status.directory ?? null} onChanged={load} />
      ) : null}
    </SettingCard>
  )
}

/**
 * Optional: real member names through the WeCom 代开发 app. Shows the
 * authorization QR, then the grant's state, with a manual re-check.
 */
function DirectoryNamesSection({
  teamId,
  directory,
  onChanged,
}: {
  teamId: string
  directory: OrgSsoDirectory | null
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [qr, setQr] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  // The admin scans on their phone; re-check whenever the window regains focus.
  React.useEffect(() => {
    if (!qr || directory) return
    const onFocus = () => void onChanged()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [qr, directory, onChanged])

  React.useEffect(() => {
    if (directory) setQr(null)
  }, [directory])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const showQr = () =>
    run(async () => {
      const { qrcodeUrl } = await getBackend().orgSso.directoryAuthLink(teamId)
      setQr(qrcodeUrl)
    })

  const sync = () =>
    run(async () => {
      const out = await getBackend().orgSso.syncDirectory(teamId)
      await onChanged()
      setNotice(
        out.directory?.namesGranted
          ? t('settings.enterpriseSso.names.synced', '已同步，更新了 {{count}} 位成员的姓名。', { count: out.updated })
          : t('settings.enterpriseSso.names.stillPending', '还不能读取姓名，请确认上线审核已通过并已授予「姓名」权限。'),
      )
    })

  let text: string
  let action: { label: string; onClick: () => void } | null
  if (!directory) {
    text = qr
      ? t('settings.enterpriseSso.names.scan', '请企业微信管理员用企业微信扫描下方二维码，授权 TeamClu 读取成员姓名。授权后回到这里。')
      : t('settings.enterpriseSso.names.description', '企业微信不向登录应用提供成员姓名。由企业微信管理员扫码授权后，成员会显示通讯录里的真实姓名；成员自己改过的名字不会被覆盖。')
    action = qr ? null : { label: t('settings.enterpriseSso.names.authorize', '获取成员姓名'), onClick: () => void showQr() }
  } else if (!directory.namesGranted) {
    text = t('settings.enterpriseSso.names.pending', '已授权，尚未生效：需要 TeamClu 完成该企业的上线审核，并由企业微信管理员授予「姓名」权限、把可见范围设为全员。')
    action = { label: t('settings.enterpriseSso.names.recheck', '重新检查'), onClick: () => void sync() }
  } else {
    text = t('settings.enterpriseSso.names.active', '已获取成员姓名。成员登录时会自动显示真实姓名。')
    action = { label: t('settings.enterpriseSso.names.syncNow', '立即同步'), onClick: () => void sync() }
  }

  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="enterprise-sso-names">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1 pl-8">
          <p className="text-[12.5px] font-medium">{t('settings.enterpriseSso.names.title', '成员姓名')}</p>
          <p className="text-[12.5px] text-muted-foreground">{text}</p>
          {directory && !directory.namesGranted && directory.lastError ? (
            <p className="text-[11.5px] text-muted-foreground">{directory.lastError}</p>
          ) : null}
          {notice ? <p className="text-[12.5px] text-muted-foreground">{notice}</p> : null}
          {error ? (
            <p className="text-[12.5px] text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {qr && !directory ? (
            <div className="pt-2">
              <div className="inline-block rounded-md bg-white p-2">
                <QRCodeSVG value={qr} size={136} />
              </div>
            </div>
          ) : null}
        </div>
        {action ? (
          <Button size="sm" variant="outline" className="shrink-0" disabled={busy} onClick={action.onClick}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
