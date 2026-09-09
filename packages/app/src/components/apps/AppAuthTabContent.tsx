import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAppsStore } from '@/stores/apps-store'
import { AppTabShell } from './AppTabShell'
import type {
  AppAuthAudience,
  AppAuthMode,
  AppAuthRule,
  AppRow,
} from '@/lib/backend/types'

/**
 * Who on the internet may open the deployed site, page by page.
 *
 * The three stored values — `authScope`, `authAudience`, `authRules` — are
 * presented as ONE question asked repeatedly: for this page, may anyone in, or
 * must they sign in, and if so must they be staff? A visitor either gets the
 * page or does not; splitting that across a scope dropdown, an audience
 * dropdown and a rules table (which is how the control panel had it) makes the
 * reader assemble the answer themselves.
 *
 * The top row is the baseline — every path no rule mentions — and is exactly
 * `authScope` + `authAudience`. Each row below overrides one path prefix.
 */

/** The one choice a row makes. */
type Access = 'public' | 'any' | 'org'

const ACCESS_OPTIONS: Access[] = ['public', 'any', 'org']

/** Read by `t` as the fallback, so the choice is legible in the source too. */
const ACCESS_FALLBACKS: Record<Access, string> = {
  public: '不需要登录',
  any: '需要登录 · 任何用户',
  org: '需要登录 · 仅员工',
}

function accessOf(rule: AppAuthRule, appAudience: AppAuthAudience): Access {
  if (rule.auth === 'public') return 'public'
  // A rule with no audience inherits the app's, so the EFFECTIVE value is what
  // the row shows — the reader is asking "who gets this page", and the answer
  // is not "it depends on a field further up".
  //
  // `appAudience` MUST be the pending baseline, not the saved one. An
  // inheriting rule follows the baseline, so moving the baseline moves that
  // rule too — and rendering it against the saved value showed 仅员工 on a row
  // the pending save was about to open to anyone with an email address. A live
  // access boundary widening while the UI says it did not is the one outcome
  // this whole tab exists to prevent.
  //
  // Inheritance is only broken when the row is CHANGED (ruleOf writes the
  // audience explicitly). An untouched rule is saved exactly as it was read, so
  // opening this tab and pressing Save cannot quietly pin an audience nobody
  // chose.
  return rule.audience ?? appAudience
}

function ruleOf(path: string, access: Access): AppAuthRule {
  if (access === 'public') return { path, auth: 'public' }
  return { path, auth: 'required', audience: access }
}

function sameRules(a: AppAuthRule[], b: AppAuthRule[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (r, i) => r.path === b[i].path && r.auth === b[i].auth && r.audience === b[i].audience,
  )
}

export function AppAuthTabContent({ appId }: { appId: string }) {
  const { t } = useTranslation()
  return (
    <AppTabShell
      appId={appId}
      title={t('apps.auth.tabTitle', '应用权限')}
      description={t(
        'apps.auth.tabDescription',
        '线上站点每个页面谁能打开。跟团队里谁能改代码无关 —— 那在「协作权限」。',
      )}
    >
      {(app) => <AuthBody app={app} />}
    </AppTabShell>
  )
}

function AccessSelect({
  value,
  onChange,
  disabled,
  testId,
}: {
  value: Access
  onChange: (next: Access) => void
  disabled?: boolean
  testId?: string
}) {
  const { t } = useTranslation()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Access)} disabled={disabled}>
      <SelectTrigger className="h-9 w-[168px] shrink-0 rounded-[7px] text-[13px]" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ACCESS_OPTIONS.map((option) => (
          <SelectItem key={option} value={option} className="text-[13px]">
            {t(`apps.auth.access.${option}`, ACCESS_FALLBACKS[option])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AuthBody({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const updateAuthPolicy = useAppsStore((s) => s.updateAuthPolicy)
  const deploy = useAppsStore((s) => s.deploy)
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))

  // Defaults applied on READ, not trusted from the type: an older server omits
  // these fields entirely, and reading `.length` off that row would take the
  // whole tab down. The fallbacks are the strict ones, so an unknown server
  // never makes an app look more open than it is.
  const rowAudience = app.authAudience ?? 'org'
  const rowScope = app.authScope ?? 'all'
  const rowRules = React.useMemo(() => app.authRules ?? [], [app.authRules])

  const [mode, setMode] = React.useState<AppAuthMode>(app.authMode)
  const [baseline, setBaseline] = React.useState<Access>(
    rowScope === 'paths' ? 'public' : rowAudience,
  )
  const [rules, setRules] = React.useState<AppAuthRule[]>(rowRules)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    setMode(app.authMode)
    setBaseline(rowScope === 'paths' ? 'public' : rowAudience)
    setRules(rowRules)
  }, [app.id, app.authMode, rowScope, rowAudience, rowRules])

  const walled = mode === 'platform'
  const scope = baseline === 'public' ? 'paths' : 'all'
  const audience: AppAuthAudience = baseline === 'public' ? rowAudience : baseline

  // The server refuses `paths` with nothing protected — it would mean "this app
  // requires a login" next to a site where every URL is open. Said here rather
  // than discovered through a 400.
  const nothingProtected = walled && scope === 'paths' && !rules.some((r) => r.auth === 'required')
  const blankPath = rules.some((r) => !r.path.trim())

  const dirty =
    mode !== app.authMode ||
    (walled && (scope !== rowScope || audience !== rowAudience || !sameRules(rules, rowRules)))

  const save = async () => {
    setSaving(true)
    try {
      await updateAuthPolicy(app.id, {
        authMode: mode,
        ...(walled ? { authAudience: audience, authScope: scope, authRules: rules } : {}),
      })
    } finally {
      setSaving(false)
    }
  }

  const setRule = (index: number, patch: Partial<AppAuthRule>) =>
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)))

  return (
    <div className="space-y-6" data-testid="app-auth-tab">
      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">
          {t('apps.controlPanel.authMode', '登录方式')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as AppAuthMode)}
            disabled={saving}
          >
            <SelectTrigger
              className="h-9 w-[220px] rounded-[7px] text-[13px]"
              data-testid="app-auth-mode"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['none', 'platform', 'third'] as AppAuthMode[]).map((m) => (
                <SelectItem key={m} value={m} disabled={m === 'third'} className="text-[13px]">
                  {t(`apps.controlPanel.authModeOption.${m}`, m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {mode === 'third' && (
          <p className="mt-2 text-[12.5px] text-muted-foreground">
            {t(
              'apps.controlPanel.authModeThirdDisabled',
              '第三方登录暂不支持部署，请选择其他方式。',
            )}
          </p>
        )}
      </section>

      {walled && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">
            {t('apps.auth.pages', '页面')}
          </h2>

          <div className="overflow-hidden rounded-lg border border-border-soft">
            <div className="flex items-center gap-2 border-b border-border-soft bg-surface-2/40 px-3 py-2.5">
              <span className="min-w-0 flex-1 text-[13px] text-foreground">
                {t('apps.auth.baseline', '其余所有页面')}
              </span>
              <AccessSelect
                value={baseline}
                onChange={setBaseline}
                disabled={saving}
                testId="app-auth-baseline"
              />
              <span className="w-9 shrink-0" aria-hidden />
            </div>

            {rules.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
                {t('apps.auth.noRules', '还没有单独设置的页面 —— 全站都按上面这条。')}
              </p>
            ) : (
              <ul className="divide-y divide-border-soft" data-testid="app-auth-rules">
                {rules.map((rule, i) => (
                  <li key={i} className="flex items-center gap-2 px-3 py-2.5">
                    <Input
                      value={rule.path}
                      onChange={(e) => setRule(i, { path: e.target.value })}
                      placeholder="/admin"
                      disabled={saving}
                      className="h-9 min-w-0 flex-1 rounded-[7px] font-mono text-[12.5px]"
                    />
                    <AccessSelect
                      value={accessOf(rule, audience)}
                      onChange={(next) => setRules((rs) =>
                        rs.map((r, j) => (j === i ? ruleOf(r.path, next) : r)),
                      )}
                      disabled={saving}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={saving}
                      className="h-9 w-9 shrink-0 text-muted-foreground"
                      onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                      aria-label={t('common.remove', 'Remove')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            className="mt-2 h-9 gap-1.5 rounded-[7px] text-[13px]"
            onClick={() => setRules((rs) => [...rs, { path: '/', auth: 'required', audience }])}
            data-testid="app-auth-add-rule"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('apps.auth.addPage', '添加一个页面')}
          </Button>

          <p className="mt-3 text-[12px] text-faint">
            {t(
              'apps.controlPanel.authRulesHint',
              '按路径前缀匹配，最长的一条生效：/admin 覆盖 /admin 及其下所有路径，但不覆盖 /administrator。',
            )}
          </p>
          <p className="mt-1.5 text-[12px] text-faint">
            {t(
              'apps.auth.audienceHint',
              '「任何用户」是任何人用邮箱注册后都能进；「仅员工」只有与这个应用同属一个组织的人能进，在登录页注册的路人进不来。',
            )}
          </p>
          {/* The limit that is easiest to misjudge, so it is stated where the
              rules are written rather than in documentation nobody opens. */}
          <p className="mt-1.5 text-[12px] text-signal">
            {t(
              'apps.controlPanel.authRulesClientRoutingWarning',
              '注意：这挡的是「谁能取到这个地址的响应」，不是「谁能看到这个界面」。应用内部跳转不经过我们，所以取数据的接口也要一并列进来。',
            )}
          </p>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border-soft pt-4">
        <Button
          type="button"
          className="h-9 rounded-[7px] text-[13px]"
          disabled={saving || !dirty || mode === 'third' || nothingProtected || blankPath}
          onClick={() => void save()}
          data-testid="app-auth-save"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save', 'Save')}
        </Button>
        {nothingProtected && (
          <span className="text-[12.5px] text-destructive" data-testid="app-auth-nothing-protected">
            {t(
              'apps.auth.nothingProtected',
              '其余页面设为公开时，至少要有一个页面需要登录 —— 否则这道墙什么也没挡。',
            )}
          </span>
        )}
        {blankPath && (
          <span className="text-[12.5px] text-destructive">
            {t('apps.auth.blankPath', '有一行还没填路径。')}
          </span>
        )}
      </div>

      {app.authModePendingRedeploy && (
        <section
          className="rounded-lg border border-border-soft bg-surface-2/40 p-3"
          data-testid="app-auth-pending-redeploy"
        >
          {/* The wall itself lives in the proxy and every change here is live
              immediately. What lags is the function's env — the Supabase
              variables an app may use ITSELF. Saying "the site is still public"
              would be false, and false in the direction that matters. */}
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            {t(
              'apps.controlPanel.authEnvPending',
              '登录设置已生效。但应用代码要读取登录用户信息，还需要重新部署一次 —— 相关配置是在部署时写进应用的。',
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-[7px] text-[13px]"
            disabled={deploying || app.provisionStatus !== 'ready'}
            onClick={() => void deploy(app.id)}
            data-testid="app-auth-redeploy-now"
          >
            {deploying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t('apps.controlPanel.redeployNow', '立即重新部署')}
          </Button>
        </section>
      )}
    </div>
  )
}
