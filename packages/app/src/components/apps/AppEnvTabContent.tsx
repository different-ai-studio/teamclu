import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { getBackend } from '@/lib/backend'
import { useAppsStore } from '@/stores/apps-store'
import { AppTabShell } from './AppTabShell'
import type { AppEnvVar, AppRow } from '@/lib/backend/types'

/**
 * The variables and secrets the deployed app runs with.
 *
 * Two kinds in one list, because they are one concept to the app — everything
 * here arrives as `process.env` — and the only difference is whether the value
 * can be read back. A secret is write-only the moment it is saved: there is no
 * reveal, for anyone, including the person who typed it. Changing one means
 * typing a new value.
 *
 * Nothing here reaches the running app until the next deploy: the environment
 * is baked into the function at finalize. Saying so is the same requirement the
 * login wall has — an operator who just pasted an API key would otherwise
 * believe it is already in effect.
 */

/**
 * Names the platform sets itself.
 *
 * A deliberate copy of `RESERVED_ENV_KEYS` / `RESERVED_ENV_PREFIX` in
 * `services/fc/src/lib/app-env.ts`, which is the ENFORCEMENT — this list only
 * buys a specific message before the round trip. If the two drift, the server
 * still refuses the name; the user just gets the generic 保存失败 toast instead
 * of "这个名字是平台自己在用的". A stale copy cannot open a hole, only degrade a
 * sentence, which is why it is duplicated rather than served.
 */
const RESERVED = new Set([
  'PORT',
  'NODE_ENV',
  'DATABASE_URL',
  'APP_PUBLIC_URL',
  'API_BASE',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
])
const RESERVED_PREFIX = 'TEAMCLU_'
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function keyProblem(key: string): 'shape' | 'reserved' | null {
  if (!KEY_RE.test(key)) return 'shape'
  if (RESERVED.has(key) || key.startsWith(RESERVED_PREFIX)) return 'reserved'
  return null
}

export function AppEnvTabContent({ appId }: { appId: string }) {
  const { t } = useTranslation()
  return (
    <AppTabShell
      appId={appId}
      title={t('apps.env.tabTitle', '变量与密钥')}
      description={t(
        'apps.env.tabDescription',
        '应用运行时读得到的环境变量。标成密钥的值存起来就再也读不出来了 —— 包括你自己。',
      )}
    >
      {(app) => <EnvBody app={app} />}
    </AppTabShell>
  )
}

function EnvBody({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const deploy = useAppsStore((s) => s.deploy)
  const deploying = useAppsStore((s) => s.deployingIds.includes(app.id))
  const invalidateAppSummary = useAppsStore((s) => s.invalidateAppSummary)
  const refreshApp = useAppsStore((s) => s.refreshApp)

  const [items, setItems] = React.useState<AppEnvVar[] | null>(null)
  const [canWrite, setCanWrite] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState<AppEnvVar | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState<AppEnvVar | null>(null)
  const [busyKey, setBusyKey] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const out = await getBackend().apps.listAppEnv(app.id)
      setItems(out?.items ?? [])
      setCanWrite(out?.canWrite ?? false)
    } catch (e) {
      console.error('[AppEnvTab] failed to load', e)
      setItems([])
      setCanWrite(false)
    } finally {
      setLoading(false)
    }
  }, [app.id])

  React.useEffect(() => {
    void load()
  }, [load])

  const failed = (e: unknown) =>
    toast.error(t('apps.env.error', '保存失败'), {
      description: e instanceof Error ? e.message : String(e),
    })

  const save = async (key: string, value: string, isSecret: boolean) => {
    const saved = await getBackend().apps.putAppEnv(app.id, key, { value, isSecret })
    if (!saved) throw new Error(t('apps.env.notAllowed', '没有权限修改这个应用的变量'))
    setItems((prev) => {
      const list = prev ?? []
      const idx = list.findIndex((v) => v.key === saved.key)
      if (idx < 0) return [...list, saved].sort((a, b) => a.key.localeCompare(b.key))
      const next = [...list]
      next[idx] = saved
      return next
    })
    setEditing(null)
    // The write moved `env_updated_at` server-side, which is what turns
    // `envPendingRedeploy` on — and that banner is the entire point of the two
    // timestamp columns. Without re-reading the row it would not appear until
    // the app list happened to reload, i.e. never, during the one session where
    // it matters.
    await refreshApp(app.id)
    invalidateAppSummary()
  }

  const remove = async (item: AppEnvVar) => {
    setBusyKey(item.key)
    try {
      const ok = await getBackend().apps.deleteAppEnv(app.id, item.key)
      if (!ok) {
        // 404 covers both "already gone" and "you no longer hold admin".
        // Closing the dialog on it left the row on screen with no explanation.
        failed(new Error(t('apps.env.deleteFailed', '删不掉 —— 它可能已经被删了，或者你已经没有权限。')))
        return
      }
      setItems((prev) => (prev ?? []).filter((v) => v.key !== item.key))
      setConfirmDelete(null)
      await refreshApp(app.id)
      invalidateAppSummary()
    } catch (e) {
      failed(e)
    } finally {
      setBusyKey(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }

  const list = items ?? []

  return (
    <div className="space-y-4" data-testid="app-env-tab">
      {app.envPendingRedeploy && (
        <section
          className="rounded-lg border border-border-soft bg-surface-2/40 p-3"
          data-testid="app-env-pending-redeploy"
        >
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            {t(
              'apps.env.pendingRedeploy',
              '这些变量还没有生效 —— 它们是在部署时写进应用的，改完要重新部署一次。',
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-[7px] text-[13px]"
            disabled={deploying || app.provisionStatus !== 'ready'}
            onClick={() => void deploy(app.id)}
            data-testid="app-env-redeploy-now"
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

      {list.length === 0 ? (
        <p className="text-[13px] text-muted-foreground" data-testid="app-env-empty">
          {t('apps.env.empty', '还没有变量。')}
        </p>
      ) : (
        <ul className="divide-y divide-border-soft rounded-lg border border-border-soft">
          {list.map((item) => (
            <li key={item.key} className="flex items-center gap-3 px-3 py-2.5">
              <span className="w-[38%] shrink-0 truncate font-mono text-[12.5px] text-foreground">
                {item.key}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
                {item.isSecret ? (
                  <span className="inline-flex items-center gap-1.5">
                    <KeyRound className="h-3 w-3 shrink-0" />
                    {t('apps.env.secretSet', '已设置（不可查看）')}
                  </span>
                ) : (
                  item.value || (
                    <span className="text-faint">{t('apps.env.emptyValue', '（空）')}</span>
                  )
                )}
              </span>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-[7px] px-2 text-[12px]"
                    onClick={() => setEditing(item)}
                    data-testid="app-env-edit"
                  >
                    {t('common.edit', '编辑')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    disabled={busyKey === item.key}
                    onClick={() => setConfirmDelete(item)}
                    aria-label={t('common.delete', '删除')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 rounded-[7px] text-[13px]"
          onClick={() => setEditing('new')}
          data-testid="app-env-new"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('apps.env.new', '新建变量')}
        </Button>
      ) : (
        <p className="text-[12.5px] text-muted-foreground" data-testid="app-env-readonly">
          {t('apps.env.readOnly', '仅创建者或 admin 可以增删改变量。')}
        </p>
      )}

      {editing && (
        <EnvDialog
          item={editing === 'new' ? null : editing}
          existingKeys={list.map((v) => v.key)}
          onCancel={() => setEditing(null)}
          onSave={save}
          onError={failed}
        />
      )}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogTitle>{t('apps.env.deleteTitle', '删除这个变量？')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'apps.env.deleteConfirm',
              '下次部署后应用就读不到它了。密钥删掉无法恢复。',
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => confirmDelete && void remove(confirmDelete)}
            >
              {t('common.delete', '删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function EnvDialog({
  item,
  existingKeys,
  onCancel,
  onSave,
  onError,
}: {
  item: AppEnvVar | null
  existingKeys: string[]
  onCancel: () => void
  onSave: (key: string, value: string, isSecret: boolean) => Promise<void>
  onError: (e: unknown) => void
}) {
  const { t } = useTranslation()
  const [key, setKey] = React.useState(item?.key ?? '')
  // Editing a secret starts blank, not with the stored value — there is no
  // stored value to show. Saving without typing one would wipe it, so the save
  // button stays disabled until something is entered.
  const [value, setValue] = React.useState(item?.isSecret ? '' : (item?.value ?? ''))
  const [isSecret, setIsSecret] = React.useState(item?.isSecret ?? false)
  const [saving, setSaving] = React.useState(false)

  const problem = key ? keyProblem(key) : null
  const duplicate = !item && existingKeys.includes(key)
  const secretNeedsValue = isSecret && !value
  const valid = key && !problem && !duplicate && !secretNeedsValue

  const submit = async () => {
    if (!valid) return
    setSaving(true)
    try {
      await onSave(key, value, isSecret)
    } catch (e) {
      onError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !saving && onCancel()}>
      <AlertDialogContent size="sm">
        <AlertDialogTitle>
          {item ? t('apps.env.editTitle', '编辑变量') : t('apps.env.new', '新建变量')}
        </AlertDialogTitle>

        <div className="space-y-3">
          <div>
            <h4 className="mb-1.5 text-[11px] font-medium text-faint">
              {t('apps.env.key', '名称')}
            </h4>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="STRIPE_SECRET_KEY"
              // A rename is a delete plus a create; the panel does not pretend
              // otherwise, so an existing variable's name is fixed here.
              disabled={saving || !!item}
              className="h-9 rounded-[7px] font-mono text-[12.5px]"
              data-testid="app-env-key"
            />
            {problem === 'shape' && (
              <p className="mt-1.5 text-[11.5px] text-destructive">
                {t('apps.env.keyShape', '只能用字母、数字和下划线，且不能以数字开头。')}
              </p>
            )}
            {problem === 'reserved' && (
              <p className="mt-1.5 text-[11.5px] text-destructive" data-testid="app-env-key-reserved">
                {t('apps.env.keyReserved', '这个名字是平台自己在用的，改不了。')}
              </p>
            )}
            {duplicate && (
              <p className="mt-1.5 text-[11.5px] text-destructive">
                {t('apps.env.keyDuplicate', '已经有同名变量了。')}
              </p>
            )}
          </div>

          <div>
            <h4 className="mb-1.5 text-[11px] font-medium text-faint">
              {t('apps.env.value', '值')}
            </h4>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type={isSecret ? 'password' : 'text'}
              placeholder={
                item?.isSecret
                  ? t('apps.env.valueReplacePlaceholder', '输入新的值来替换')
                  : undefined
              }
              disabled={saving}
              className="h-9 rounded-[7px] font-mono text-[12.5px]"
              data-testid="app-env-value"
            />
            {item?.isSecret && (
              <p className="mt-1.5 text-[11.5px] text-faint">
                {t('apps.env.valueReplaceHint', '密钥读不出来，只能整个换掉。')}
              </p>
            )}
          </div>

          <label className="flex items-start gap-2.5">
            <Switch
              checked={isSecret}
              onCheckedChange={setIsSecret}
              disabled={saving}
              data-testid="app-env-is-secret"
            />
            <span className="text-[12.5px] text-muted-foreground">
              {t(
                'apps.env.isSecretHint',
                '存成密钥：加密保存，之后谁都读不出来（包括你），只能替换。',
              )}
            </span>
          </label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={saving || !valid}
            onClick={(e) => {
              e.preventDefault()
              void submit()
            }}
            data-testid="app-env-save"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.save', 'Save')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
