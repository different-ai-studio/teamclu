import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getBackend } from '@/lib/backend'
import type { AppAuthInfo } from '@/lib/backend/types'
import {
  type AppAuthRowState,
  baselineToRowState,
  buildAuthPolicyPatch,
  exceptionRulesToRowState,
  sameAuthRow,
} from '@/lib/apps/app-auth-access'
import { useAppsStore } from '@/stores/apps-store'
import { AppTabShell } from './AppTabShell'
import type { AppAuthMode, AppRow } from '@/lib/backend/types'

/**
 * Who on the internet may open the deployed site, page by page.
 *
 * Each row names a path, login requirement, and explicit audience mode.
 * Dynamic organization access and inherited defaults never become fixed roles.
 * The top row is the baseline — every path no rule mentions.
 */

function LoginSelect({
  value,
  onChange,
  disabled,
  testId,
}: {
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  testId?: string
}) {
  const { t } = useTranslation()
  return (
    <Select
      value={value ? 'required' : 'public'}
      onValueChange={(v) => onChange(v === 'required')}
      disabled={disabled}
    >
      <SelectTrigger
        className="h-9 w-[128px] shrink-0 rounded-[7px] text-[13px]"
        data-testid={testId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="public" className="text-[13px]">
          {t('apps.auth.login.public', '不需要登录')}
        </SelectItem>
        <SelectItem value="required" className="text-[13px]">
          {t('apps.auth.login.required', '需要登录')}
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

function RolesMultiSelect({
  roleCodes,
  options,
  disabled,
  testId,
  onChange,
}: {
  roleCodes: string[]
  options: AppAuthInfo['roles']
  disabled?: boolean
  testId?: string
  onChange: (next: string[]) => void
}) {
  const { t } = useTranslation()
  const label =
    roleCodes.length === 0
      ? t('apps.auth.roles.choose', '选择至少一个角色')
      : roleCodes.join(', ')

  const toggle = (code: string, checked: boolean) => {
    if (checked) onChange([...roleCodes, code].sort())
    else onChange(roleCodes.filter((c) => c !== code))
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid={testId}
          className="h-9 min-w-[140px] max-w-[220px] shrink-0 justify-between gap-1 rounded-[7px] px-2.5 text-[12.5px] font-normal"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] p-2">
        {options.length === 0 && roleCodes.length === 0 ? (
          <p className="px-1 py-2 text-[12.5px] text-muted-foreground">
            {t('apps.auth.roles.empty', '还没有可分配的角色')}
          </p>
        ) : (
          <ul className="max-h-[220px] space-y-0.5 overflow-y-auto">
            {[...options, ...roleCodes.filter(code => !options.some(role => role.code === code)).map(code => ({ id: code, code, name: code, status: 'missing' }))].map((role) => {
              const checked = roleCodes.includes(role.code)
              return (
                <li key={role.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-[12.5px] hover:bg-selected">
                    <Checkbox
                      checked={checked}
                      disabled={role.status !== 'active' && !checked}
                      onCheckedChange={(v) => toggle(role.code, v === true)}
                    />
                    <span className="min-w-0 truncate">
                      <span className="text-foreground">{role.name}{role.status !== 'active' ? ` (${t('apps.auth.roles.unavailable', '已停用或缺失')})` : ''}</span>
                      <span className="ml-1 font-mono text-[11px] text-faint">{role.code}</span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
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
      {(app) => <AuthBody key={app.id} app={app} />}
    </AppTabShell>
  )
}

function AuthBody({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const updateAuthPolicy = useAppsStore((s) => s.updateAuthPolicy)
  const deploy = useAppsStore((s) => s.deploy)
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))

  const [mode, setMode] = React.useState<AppAuthMode>(app.authMode)
  const [orgRoles, setOrgRoles] = React.useState<AppAuthInfo['roles']>([])
  const [organization, setOrganization] = React.useState<AppAuthInfo['organization']>(null)
  const [rolesLoaded, setRolesLoaded] = React.useState(false)
  const [rolesError, setRolesError] = React.useState(false)
  const [policy, setPolicy] = React.useState(app)
  const [baseline, setBaseline] = React.useState(() => baselineToRowState(app))
  const [rules, setRules] = React.useState(() => exceptionRulesToRowState(app))
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<'write' | 'readback' | null>(null)
  const [defaultConfirmed, setDefaultConfirmed] = React.useState(false)
  const active = React.useRef(true)

  const acceptPolicy = (next: AppRow) => {
    setPolicy(next)
    setMode(next.authMode)
    setBaseline(baselineToRowState(next))
    setRules(exceptionRulesToRowState(next))
    setDefaultConfirmed(false)
  }
  React.useEffect(() => {
    active.current = true
    let cancelled = false
    void getBackend().apps.getAppAuthInfo(app.id).then(info => {
      if (cancelled) return
      setOrgRoles(info.roles)
      setOrganization(info.organizationStatus === 'configured' ? info.organization : null)
      setRolesLoaded(true)
      acceptPolicy({ ...app, authMode: info.authMode, authScope: info.authScope, authAudience: info.authAudience, authRules: info.authRules })
    }).catch(() => { if (!cancelled) setRolesError(true) })
    return () => { cancelled = true; active.current = false }
    // Store/catalog updates must never reset a draft. The body is keyed by app id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id])

  const walled = mode === 'platform'
  const nothingProtected = walled && !baseline.requiresLogin && !rules.some(r => r.requiresLogin)
  const blankPath = rules.some(r => !r.path.trim())
  const emptySelection = [baseline, ...rules].some(r => r.requiresLogin && r.audienceMode === 'org_roles' && !r.roleCodes.length)
  const dirty = mode !== policy.authMode || (walled &&
    (!sameAuthRow(baseline, baselineToRowState(policy)) || rules.length !== exceptionRulesToRowState(policy).length ||
      rules.some((r, i) => !sameAuthRow(r, exceptionRulesToRowState(policy)[i]!))))
  const defaultChanged = baseline.source === 'app_baseline' && baseline.audienceMode !== 'org_roles' && baseline.audienceMode !== baselineToRowState(policy).audienceMode &&
    rules.some(r => r.requiresLogin && r.audienceMode === 'inherit')
  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const succeeded = await updateAuthPolicy(app.id, { authMode: mode,
        ...(walled ? buildAuthPolicyPatch(baseline, rules, policy) : {}) })
      if (!active.current) return
      if (!succeeded) { setSaveError('write'); return }
      try {
        const [info, serverApp] = await Promise.all([getBackend().apps.getAppAuthInfo(app.id), getBackend().apps.getApp(app.id)])
        if (!active.current) return
        if (!serverApp) throw new Error('App unavailable')
        setOrgRoles(info.roles)
        setOrganization(info.organizationStatus === 'configured' ? info.organization : null)
        acceptPolicy({ ...serverApp, authMode: info.authMode, authScope: info.authScope, authAudience: info.authAudience, authRules: info.authRules })
      } catch { if (active.current) setSaveError('readback') }
    } catch { if (active.current) setSaveError('write') }
    finally { if (active.current) setSaving(false) }
  }

  const audienceControl = (row: AppAuthRowState, testId: string, onChange: (patch: Partial<AppAuthRowState>) => void) => (
    <div className="space-y-1">
      <Select value={row.audienceMode} onValueChange={value => { onChange({ audienceMode: value as AppAuthRowState['audienceMode'], roleCodes: [] }); setDefaultConfirmed(false) }}
        disabled={saving || !row.requiresLogin || !rolesLoaded || rolesError}>
        <SelectTrigger data-testid={testId} className="h-9 rounded-[7px] text-[12.5px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="any_authenticated">{t('apps.auth.audience.any', '任意已登录用户')}</SelectItem>
          <SelectItem value="any_org_role" disabled={!organization}>{t('apps.auth.audience.org', '组织内任意有效角色')}</SelectItem>
          <SelectItem value="org_roles" disabled={!organization}>{t('apps.auth.audience.roles', '指定组织角色之一')}</SelectItem>
          {(row.audienceMode === 'inherit' || (row.originalRule?.auth === 'required' && row.originalRule.roles === undefined && row.originalRule.audience === undefined)) && <SelectItem value="inherit">{t('apps.auth.audience.inherit', '继承应用默认')} · {(baseline.source === 'app_baseline' && baseline.audienceMode !== 'org_roles' ? baseline.audienceMode === 'any_authenticated' : policy.authAudience === 'any') ? t('apps.auth.audience.any', '任意已登录用户') : t('apps.auth.audience.org', '组织内任意有效角色')}</SelectItem>}
        </SelectContent>
      </Select>
      {row.requiresLogin && row.audienceMode === 'org_roles' && <RolesMultiSelect roleCodes={row.roleCodes} options={orgRoles}
        disabled={saving || !organization || !rolesLoaded || rolesError} testId={`${testId}-codes`} onChange={roleCodes => onChange({ roleCodes })} />}
    </div>
  )

  const setRule = (index: number, patch: Partial<AppAuthRowState>) =>
    setRules((rs) =>
      rs.map((r, i) => {
        if (i !== index) return r
        const next = { ...r, ...patch }
        if (patch.requiresLogin === false) next.roleCodes = []
        return next
      }),
    )

  const setBaselineLogin = (requiresLogin: boolean) =>
    setBaseline((b) => ({
      ...b,
      requiresLogin,
      roleCodes: requiresLogin ? b.roleCodes : [],
    }))

  return (
    <div className="space-y-6" data-testid="app-auth-tab">
      {!rolesLoaded && !rolesError && <p data-testid="app-auth-loading">{t('common.loading', '加载中')}</p>}
      {organization && <p className="text-[12.5px] text-muted-foreground">{t('apps.auth.organization', '组织角色范围')} · {organization.name}</p>}
      {rolesLoaded && !organization && <p className="text-destructive">{t('apps.auth.organizationMissing', '应用未配置组织，无法配置组织受众。')}</p>}
      {saveError && <p role="alert" data-testid={saveError === 'readback' ? 'app-auth-readback-error' : 'app-auth-save-error'} className="text-destructive">
        {saveError === 'readback' ? t('apps.auth.readbackFailed', '保存已成功，确认读取失败。草稿已保留，请重新打开确认。') : t('apps.auth.saveFailed', '保存失败，草稿已保留。')}
      </p>}
      {emptySelection && <p role="alert" className="text-destructive">{t('apps.auth.rolesRequired', '指定角色模式至少选择一个角色；任意用户请切换到任意已登录用户。')}</p>}
      {defaultChanged && <label className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={defaultConfirmed} onCheckedChange={v => setDefaultConfirmed(v === true)} />
        {t('apps.auth.confirmDefault', '确认更改应用默认受众，以下继承规则也将改变：')} {rules.filter(r => r.requiresLogin && r.audienceMode === 'inherit').map(r => r.path).join(', ')}
      </label>}
      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">
          {t('apps.controlPanel.authMode', '登录方式')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as AppAuthMode)}
            disabled={saving || !rolesLoaded || rolesError}
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
            <div className="grid grid-cols-[minmax(0,1fr)_128px_minmax(140px,220px)_36px] items-center gap-2 border-b border-border-soft bg-surface-2/40 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
              <span>{t('apps.auth.col.path', '页面地址')}</span>
              <span>{t('apps.auth.col.login', '是否需要登录')}</span>
              <span>{t('apps.auth.col.roles', '角色')}</span>
              <span aria-hidden />
            </div>

            <div
              className="grid grid-cols-[minmax(0,1fr)_128px_minmax(140px,220px)_36px] items-center gap-2 border-b border-border-soft px-3 py-2.5"
              data-testid="app-auth-baseline"
            >
              <span className="min-w-0 text-[13px] text-foreground">
                {t('apps.auth.baseline', '其余所有页面')}
              </span>
              <LoginSelect
                value={baseline.requiresLogin}
                onChange={setBaselineLogin}
                disabled={saving || !rolesLoaded || rolesError}
                testId="app-auth-baseline-login"
              />
              {audienceControl(baseline, 'app-auth-baseline-roles', patch => setBaseline(b => ({ ...b, ...patch })))}
              <span className="w-9 shrink-0" aria-hidden />
            </div>

            {rules.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
                {t('apps.auth.noRules', '还没有单独设置的页面 —— 全站都按上面这条。')}
              </p>
            ) : (
              <ul className="divide-y divide-border-soft" data-testid="app-auth-rules">
                {rules.map((rule, i) => (
                  <li
                    key={i}
                    className="grid grid-cols-[minmax(0,1fr)_128px_minmax(140px,220px)_36px] items-center gap-2 px-3 py-2.5"
                  >
                    <Input
                      value={rule.path}
                      onChange={(e) => setRule(i, { path: e.target.value })}
                      placeholder="/admin"
                      disabled={saving || !rolesLoaded || rolesError}
                      className="h-9 min-w-0 rounded-[7px] font-mono text-[12.5px]"
                      data-testid={`app-auth-rule-path-${i}`}
                    />
                    <LoginSelect
                      value={rule.requiresLogin}
                      onChange={(requiresLogin) => setRule(i, { requiresLogin })}
                      disabled={saving || !rolesLoaded || rolesError}
                      testId={`app-auth-rule-login-${i}`}
                    />
                    {audienceControl(rule, `app-auth-rule-roles-${i}`, patch => setRule(i, patch))}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={saving || !rolesLoaded || rolesError}
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
            disabled={saving || !rolesLoaded || rolesError}
            className="mt-2 h-9 gap-1.5 rounded-[7px] text-[13px]"
            onClick={() =>
              setRules((rs) => [
                ...rs,
                {
                  path: '',
                  requiresLogin: true,
                  audienceMode: 'inherit',
                  roleCodes: [],
                  source: 'rule',
                },
              ])
            }
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
              'apps.auth.rolesHint',
              '组织内任意有效角色动态包含未来角色；指定组织角色只允许所选角色之一。',
            )}
          </p>
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
          disabled={saving || !dirty || mode === 'third' || nothingProtected || blankPath || emptySelection || !rolesLoaded || rolesError || (defaultChanged && !defaultConfirmed) || (walled && !organization && [baseline, ...rules].some(r => r.requiresLogin && (r.audienceMode === 'any_org_role' || r.audienceMode === 'org_roles' || (r.audienceMode === 'inherit' && policy.authAudience !== 'any'))))}
          onClick={() => void save()}
          data-testid="app-auth-save"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save', 'Save')}
        </Button>
        {rolesError && (
          <span className="text-[12.5px] text-destructive" data-testid="app-auth-roles-error">
            {t(
              'apps.auth.rolesLoadFailed',
              '角色列表加载失败，原规则已保留，暂时无法修改或保存。请重试。',
            )}
          </span>
        )}
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
