import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppsStore } from '@/stores/apps-store'
import type { AppCustomDomain, AppRow } from '@/lib/backend/types'

/**
 * Binding a domain the app's owner controls.
 *
 * Three states, and the middle one is the whole reason this is not a single
 * text field: a bound-but-unverified domain has DNS records the owner still has
 * to publish, and those records carry a token that lives only on the server.
 * Re-binding the same name is idempotent precisely so this can re-read them
 * after a reload without invalidating a record the owner already added.
 */

function DnsRow({ record }: { record: AppCustomDomain['dns'][number] }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(record.value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard is unavailable in some webview contexts; the value is on
      // screen and selectable, so this is not worth an error dialog.
      toast.error(t('apps.controlPanel.domainCopyFailed', '复制失败，请手动选中'))
    }
  }

  return (
    <div className="flex items-start gap-2 border-t border-border-soft/60 py-1.5 first:border-t-0">
      <span className="w-[52px] shrink-0 pt-0.5 font-mono text-[11px] font-semibold text-accent">
        {record.type}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-all font-mono text-[11.5px] text-ink-2">{record.name}</div>
        <div className="break-all font-mono text-[11.5px]">{record.value}</div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 shrink-0 rounded-[6px] p-0"
        onClick={() => void copy()}
        aria-label={t('common.copy', 'Copy')}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}

export function AppCustomDomainSection({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const bind = useAppsStore((s) => s.bindCustomDomain)
  const verify = useAppsStore((s) => s.verifyCustomDomain)
  const unbind = useAppsStore((s) => s.unbindCustomDomain)

  const [draft, setDraft] = React.useState(app.customDomain ?? '')
  const [records, setRecords] = React.useState<AppCustomDomain['dns']>([])
  const [busy, setBusy] = React.useState<'bind' | 'verify' | 'unbind' | null>(null)
  const [pendingMessage, setPendingMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    setDraft(app.customDomain ?? '')
    setRecords([])
    setPendingMessage(null)
  }, [app.id, app.customDomain])

  const bound = Boolean(app.customDomain)
  const verified = Boolean(app.customDomainVerifiedAt)

  const doBind = async () => {
    const domain = draft.trim()
    if (!domain) return
    setBusy('bind')
    setPendingMessage(null)
    try {
      const out = await bind(app.id, domain)
      if (out) setRecords(out.dns)
    } finally {
      setBusy(null)
    }
  }

  const doVerify = async () => {
    setBusy('verify')
    setPendingMessage(null)
    try {
      const result = await verify(app.id)
      if (result.status === 'pending') setPendingMessage(result.message)
      if (result.status === 'verified') {
        setRecords([])
        toast.success(t('apps.controlPanel.domainVerified', '域名已生效'))
      }
    } finally {
      setBusy(null)
    }
  }

  const doUnbind = async () => {
    setBusy('unbind')
    try {
      await unbind(app.id)
      setRecords([])
      setDraft('')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('apps.controlPanel.customDomainPlaceholder', 'app.example.com')}
          disabled={busy !== null}
          className="h-8 flex-1 rounded-[7px] font-mono text-[12.5px]"
          data-testid="app-control-domain-input"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 rounded-[7px] text-[12px]"
          disabled={busy !== null || !draft.trim() || draft.trim() === app.customDomain}
          onClick={() => void doBind()}
          data-testid="app-control-domain-bind"
        >
          {busy === 'bind' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            t('apps.controlPanel.customDomainBind', '绑定')
          )}
        </Button>
      </div>

      {bound && (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              verified
                ? 'rounded-[6px] border border-verified/40 px-2 py-0.5 text-[11px] font-medium text-verified'
                : 'rounded-[6px] border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
            }
            data-testid="app-control-domain-status"
          >
            {verified
              ? t('apps.controlPanel.domainStatusVerified', '已生效')
              : t('apps.controlPanel.domainStatusPending', '待校验')}
          </span>
          {!verified && (
            <>
              <Button
                type="button"
                size="sm"
                className="h-7 rounded-[7px] text-[11.5px]"
                disabled={busy !== null}
                onClick={() => void doVerify()}
                data-testid="app-control-domain-verify"
              >
                {busy === 'verify' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t('apps.controlPanel.domainVerify', '我已添加，去校验')
                )}
              </Button>
              {records.length === 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-[7px] text-[11.5px]"
                  disabled={busy !== null}
                  onClick={() => void doBind()}
                >
                  {t('apps.controlPanel.domainShowRecords', '查看要添加的记录')}
                </Button>
              )}
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 rounded-[7px] text-[11.5px] text-destructive"
            disabled={busy !== null}
            onClick={() => void doUnbind()}
          >
            {busy === 'unbind' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t('apps.controlPanel.domainUnbind', '解绑')
            )}
          </Button>
        </div>
      )}

      {pendingMessage && (
        <p className="text-[11.5px] text-signal" data-testid="app-control-domain-pending">
          {t(
            'apps.controlPanel.domainPendingHint',
            '还没查到这条 TXT 记录。DNS 生效通常要几分钟，稍后再试一次。',
          )}
        </p>
      )}

      {records.length > 0 && (
        <div className="rounded-[7px] border border-border bg-surface px-2.5 py-1">
          {records.map((r) => (
            <DnsRow key={`${r.type}:${r.name}`} record={r} />
          ))}
        </div>
      )}

      <p className="text-[11.5px] text-faint">
        {t(
          'apps.controlPanel.customDomainHint',
          '域名需要能解析到我们，且完成 ICP 备案后才能在境内正常访问 —— 未备案的域名可能被运营商拦截，这一层我们挡不住。',
        )}
      </p>
    </div>
  )
}
