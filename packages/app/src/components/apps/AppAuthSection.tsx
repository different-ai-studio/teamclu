import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, X } from 'lucide-react'
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
import type {
  AppAuthAudience,
  AppAuthMode,
  AppAuthRule,
  AppAuthScope,
  AppRow,
} from '@/lib/backend/types'

/**
 * The login wall's three settings, saved together.
 *
 * Together is not a convenience: the server validates `authScope` against
 * `authRules` as a pair and rejects "only protect these paths" with nothing
 * marked required, so two separate saves would be refused on the intermediate
 * state. One button, one request.
 */

const AUTH_MODES: AppAuthMode[] = ['none', 'platform', 'third']
const AUDIENCES: AppAuthAudience[] = ['any', 'org']
const SCOPES: AppAuthScope[] = ['all', 'paths']

/** Two rule lists are equal when the same paths carry the same verdicts. */
function sameRules(a: AppAuthRule[], b: AppAuthRule[]): boolean {
  if (a.length !== b.length) return false
  return a.every((r, i) => r.path === b[i].path && r.auth === b[i].auth)
}

export function AppAuthSection({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const updateAuthPolicy = useAppsStore((s) => s.updateAuthPolicy)

  // Defaults applied on read, not just trusted from the type.
  //
  // A desktop can be newer than the API it is talking to, and an older server
  // answers without these fields at all — reading `app.authRules.length` off
  // that row throws and takes the whole control panel down. Falling back to the
  // STRICT values also means an unknown server never makes an app look more
  // open than it is.
  const rowAudience = app.authAudience ?? 'org'
  const rowScope = app.authScope ?? 'all'
  const rowRules = React.useMemo(() => app.authRules ?? [], [app.authRules])

  const [mode, setMode] = React.useState<AppAuthMode>(app.authMode)
  const [audience, setAudience] = React.useState<AppAuthAudience>(rowAudience)
  const [scope, setScope] = React.useState<AppAuthScope>(rowScope)
  const [rules, setRules] = React.useState<AppAuthRule[]>(rowRules)
  const [saving, setSaving] = React.useState(false)

  // Re-seed from the row whenever the server's answer arrives or the app
  // changes: the panel stays mounted while the user switches apps.
  React.useEffect(() => {
    setMode(app.authMode)
    setAudience(rowAudience)
    setScope(rowScope)
    setRules(rowRules)
  }, [app.id, app.authMode, rowAudience, rowScope, rowRules])

  const walled = mode === 'platform'
  const dirty =
    mode !== app.authMode ||
    (walled &&
      (audience !== rowAudience ||
        scope !== rowScope ||
        !sameRules(rules, rowRules)))

  const save = async () => {
    setSaving(true)
    try {
      await updateAuthPolicy(app.id, {
        authMode: mode,
        // Only meaningful with a wall, and sending them for `none` would store
        // settings the user never chose in this state.
        ...(walled
          ? { authAudience: audience, authScope: scope, authRules: rules }
          : {}),
      })
    } finally {
      setSaving(false)
    }
  }

  const setRule = (index: number, patch: Partial<AppAuthRule>) =>
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={mode} onValueChange={(v) => setMode(v as AppAuthMode)} disabled={saving}>
          <SelectTrigger
            className="h-8 min-w-0 flex-1 rounded-[7px] text-[12px]"
            data-testid="app-control-auth-mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_MODES.map((m) => (
              <SelectItem key={m} value={m} disabled={m === 'third'} className="text-[12px]">
                {t(`apps.controlPanel.authModeOption.${m}`, m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 rounded-[7px] text-[12px]"
          disabled={saving || !dirty || mode === 'third'}
          onClick={() => void save()}
          data-testid="app-control-auth-save"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save', 'Save')}
        </Button>
      </div>

      {mode === 'third' && (
        <p className="text-[12px] text-muted-foreground">
          {t(
            'apps.controlPanel.authModeThirdDisabled',
            '第三方登录暂不支持部署，请选择其他方式。',
          )}
        </p>
      )}

      {walled && (
        <>
          <div>
            <h5 className="mb-1.5 text-[11px] font-medium text-faint">
              {t('apps.controlPanel.authAudience', '谁可以进入')}
            </h5>
            <Select
              value={audience}
              onValueChange={(v) => setAudience(v as AppAuthAudience)}
              disabled={saving}
            >
              <SelectTrigger
                className="h-8 rounded-[7px] text-[12px]"
                data-testid="app-control-auth-audience"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIENCES.map((a) => (
                  <SelectItem key={a} value={a} className="text-[12px]">
                    {t(`apps.controlPanel.authAudienceOption.${a}`, a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-[11.5px] text-faint">
              {audience === 'any'
                ? t(
                    'apps.controlPanel.authAudienceAnyHint',
                    '任何人都可以用邮箱注册一个账号后进入。适合对外的产品页。',
                  )
                : t(
                    'apps.controlPanel.authAudienceOrgHint',
                    '只有与这个应用同属一个组织的人能进入。在应用登录页注册的路人会被挡在外面。',
                  )}
            </p>
          </div>

          <div>
            <h5 className="mb-1.5 text-[11px] font-medium text-faint">
              {t('apps.controlPanel.authScope', '拦哪些页面')}
            </h5>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as AppAuthScope)}
              disabled={saving}
            >
              <SelectTrigger
                className="h-8 rounded-[7px] text-[12px]"
                data-testid="app-control-auth-scope"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPES.map((s) => (
                  <SelectItem key={s} value={s} className="text-[12px]">
                    {t(`apps.controlPanel.authScopeOption.${s}`, s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="mt-2 space-y-1.5" data-testid="app-control-auth-rules">
              {rules.map((rule, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    value={rule.path}
                    onChange={(e) => setRule(i, { path: e.target.value })}
                    placeholder="/admin"
                    disabled={saving}
                    className="h-8 flex-1 rounded-[7px] font-mono text-[12px]"
                  />
                  <Select
                    value={rule.auth}
                    onValueChange={(v) => setRule(i, { auth: v as AppAuthRule['auth'] })}
                    disabled={saving}
                  >
                    <SelectTrigger className="h-8 w-[104px] shrink-0 rounded-[7px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="required" className="text-[12px]">
                        {t('apps.controlPanel.authRuleRequired', '需要登录')}
                      </SelectItem>
                      <SelectItem value="public" className="text-[12px]">
                        {t('apps.controlPanel.authRulePublic', '公开')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    className="h-8 w-8 shrink-0 rounded-[7px] p-0"
                    onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                    aria-label={t('common.remove', 'Remove')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                className="h-8 gap-1.5 rounded-[7px] text-[12px]"
                onClick={() => setRules((rs) => [...rs, { path: '/', auth: 'required' }])}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('apps.controlPanel.authRuleAdd', '添加例外')}
              </Button>
            </div>

            <p className="mt-1.5 text-[11.5px] text-faint">
              {t(
                'apps.controlPanel.authRulesHint',
                '按路径前缀匹配，最长的一条生效：/admin 覆盖 /admin 及其下所有路径，但不覆盖 /administrator。',
              )}
            </p>
            {/* The limit that is easiest to misjudge, so it is stated where the
                rules are written rather than in documentation nobody opens. */}
            <p className="mt-1 text-[11.5px] text-signal">
              {t(
                'apps.controlPanel.authRulesClientRoutingWarning',
                '注意：这挡的是「谁能取到这个地址的响应」，不是「谁能看到这个界面」。应用内部跳转不经过我们，所以取数据的接口也要一并列进来。',
              )}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
