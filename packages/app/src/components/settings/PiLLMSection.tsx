import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  Cpu,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspaceStore } from '@/stores/workspace'
import { cn, isTauri } from '@/lib/utils'
import {
  deletePiCustomProvider,
  getPiCustomProviders,
  getPiProviders,
  logoutPiProvider,
  putPiCustomProvider,
  refreshPiProviders,
  type PiAuthType,
  type PiProvider,
  type PiProviderList,
} from '@/lib/daemon-pi-auth'
import { encodeWorkspaceId } from '@/lib/daemon-local-client'
import { SectionHeader, SettingCard } from './shared'
import { TeamProviderCard } from './llm/TeamProviderCard'
import { PiLoginDialog } from './llm/PiLoginDialog'
import { PiCustomProviderDialog } from './llm/PiCustomProviderDialog'

/**
 * pi LLM settings — the full `pi /login` surface, in the app.
 *
 * This pane used to be a read-only model list that told the user to go run
 * `pi /login` in a terminal. It now drives pi's own `ModelRuntime` through the
 * daemon: every provider pi knows, its auth methods, sign-in and sign-out, and
 * the custom providers in `models.json`.
 *
 * Nothing about any provider is hard-coded here. The list, the auth methods
 * offered per provider, the questions asked during a login and the wording of
 * its prompts all come from pi, so a provider or flow pi adds later shows up
 * without a change on this side. That is also why this is not built on the
 * `/v1/providers` routes next door: those proxy opencode's serve API and know
 * nothing about pi's credentials.
 */
export function PiLLMSection() {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  // Only ever a hint about where to start a pi host if none is running; pi's
  // credentials are device-wide, so the pane works with no workspace open.
  const workspaceId = React.useMemo(
    () => (workspacePath ? encodeWorkspaceId(workspacePath) : null),
    [workspacePath],
  )

  const [data, setData] = React.useState<PiProviderList | null>(null)
  const [custom, setCustom] = React.useState<Record<string, Record<string, unknown>>>({})
  // Set when `models.json` could not be read — a hand-edit that left it
  // malformed, most likely. Reported rather than shown as "none configured",
  // which would invite an edit that then fails on save for reasons the pane
  // never mentioned.
  const [customError, setCustomError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busyProvider, setBusyProvider] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState('')
  const [showAll, setShowAll] = React.useState(false)

  const [login, setLogin] = React.useState<{
    providerId: string
    providerName: string
    authType: PiAuthType
  } | null>(null)
  const [editor, setEditor] = React.useState<{ id: string | null } | null>(null)

  const load = React.useCallback(async () => {
    if (!isTauri()) {
      setLoading(false)
      return
    }
    setError(null)
    try {
      const [providers, customProviders] = await Promise.all([
        getPiProviders(workspaceId),
        // A broken models.json must not blank the provider list — pi still
        // serves every built-in provider — so its failure is caught here and
        // reported by the custom-provider card instead of by the whole pane.
        getPiCustomProviders(workspaceId).then(
          (value) => ({ value, error: null as string | null }),
          (e: unknown) => ({
            value: null,
            error: e instanceof Error ? e.message : String(e),
          }),
        ),
      ])
      setData(providers)
      setCustom(customProviders.value?.providers ?? {})
      setCustomError(customProviders.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshPiProviders(undefined, workspaceId)
    } catch {
      // Reported by the reload below if it is a real outage; a catalog refresh
      // that fails still leaves the cached models usable.
    }
    await load()
    setRefreshing(false)
  }, [load, workspaceId])

  const handleLogout = React.useCallback(
    async (provider: PiProvider) => {
      setBusyProvider(provider.id)
      setError(null)
      try {
        await logoutPiProvider(provider.id, workspaceId)
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyProvider(null)
      }
    },
    [load, workspaceId],
  )

  const handleDeleteCustom = React.useCallback(
    async (providerId: string) => {
      setBusyProvider(providerId)
      setError(null)
      try {
        await deletePiCustomProvider(providerId, workspaceId)
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyProvider(null)
      }
    },
    [load, workspaceId],
  )

  const providers = data?.providers ?? []
  const configured = React.useMemo(() => providers.filter((p) => p.configured), [providers])
  const available = React.useMemo(() => providers.filter((p) => !p.configured), [providers])

  const needle = filter.trim().toLowerCase()
  const matches = React.useCallback(
    (p: PiProvider) =>
      !needle || p.id.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
    [needle],
  )
  const filteredAvailable = available.filter(matches)
  // 40-odd providers is a wall of buttons for someone who wants one; the list
  // stays collapsed until asked for, and a search always expands it.
  const visibleAvailable = showAll || needle ? filteredAvailable : filteredAvailable.slice(0, 6)

  const customIds = Object.keys(custom)

  return (
    <div>
      <SectionHeader
        icon={Cpu}
        title={t('settings.piLlm.title', 'Pi 模型')}
        description={t(
          'settings.piLlm.description',
          'pi 运行时自带的模型与 provider，由主机上的 pi 凭证管理。',
        )}
      />

      {/* Pinned above pi's own providers: the team gateway needs no login. */}
      <TeamProviderCard className="mb-4" />

      {!isTauri() ? (
        <SettingCard>
          <p className="p-1 text-[12.5px] text-muted-foreground">
            {t('settings.piLlm.desktopOnly', 'Pi provider 配置仅在桌面端可用。')}
          </p>
        </SettingCard>
      ) : loading ? (
        <SettingCard>
          <div className="flex items-center gap-2 p-1 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading', '加载中…')}
          </div>
        </SettingCard>
      ) : (
        <div className="flex flex-col gap-4">
          {error && (
            <SettingCard>
              <div className="flex items-start gap-2 p-1 text-[12.5px]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span className="text-foreground">{error}</span>
              </div>
            </SettingCard>
          )}

          {/* ── Configured ─────────────────────────────────────────────── */}
          <SettingCard className="p-0">
            <div className="flex items-center justify-between border-b border-border-soft px-4 py-2.5">
              <span className="text-[12.5px] font-medium text-foreground">
                {t('settings.piLlm.configured', '已配置的 Provider')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                disabled={refreshing}
                onClick={() => void handleRefresh()}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                {t('common.refresh', '刷新')}
              </Button>
            </div>
            {configured.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                {t(
                  'settings.piLlm.noneConfigured',
                  '还没有配置任何 provider。从下方选择一个登录，即可开始使用模型。',
                )}
              </p>
            ) : (
              <ul className="divide-y divide-border-soft">
                {configured.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    busy={busyProvider === provider.id}
                    onLogin={(authType) =>
                      setLogin({ providerId: provider.id, providerName: provider.name, authType })
                    }
                    onLogout={() => void handleLogout(provider)}
                  />
                ))}
              </ul>
            )}
          </SettingCard>

          {/* ── Available ──────────────────────────────────────────────── */}
          <SettingCard className="p-0">
            <div className="flex items-center gap-3 border-b border-border-soft px-4 py-2.5">
              <span className="shrink-0 text-[12.5px] font-medium text-foreground">
                {t('settings.piLlm.available', '可用 Provider')}
              </span>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('settings.piLlm.searchPlaceholder', '搜索 provider…')}
                className="h-7 flex-1 text-[12px]"
              />
            </div>
            {filteredAvailable.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                {t('settings.piLlm.noMatches', '没有匹配的 provider。')}
              </p>
            ) : (
              <>
                <ul className="divide-y divide-border-soft">
                  {visibleAvailable.map((provider) => (
                    <ProviderRow
                      key={provider.id}
                      provider={provider}
                      busy={busyProvider === provider.id}
                      onLogin={(authType) =>
                        setLogin({
                          providerId: provider.id,
                          providerName: provider.name,
                          authType,
                        })
                      }
                      onLogout={() => void handleLogout(provider)}
                    />
                  ))}
                </ul>
                {!needle && filteredAvailable.length > visibleAvailable.length && (
                  <button
                    type="button"
                    className="w-full border-t border-border-soft px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-selected hover:text-foreground"
                    onClick={() => setShowAll(true)}
                  >
                    {t('settings.piLlm.showAll', '显示全部 {{count}} 个', {
                      count: filteredAvailable.length,
                    })}
                  </button>
                )}
              </>
            )}
          </SettingCard>

          {/* ── Custom providers (models.json) ─────────────────────────── */}
          <SettingCard className="p-0">
            <div className="flex items-center justify-between border-b border-border-soft px-4 py-2.5">
              <div className="min-w-0">
                <span className="text-[12.5px] font-medium text-foreground">
                  {t('settings.piLlm.customProviders', '自定义 Provider')}
                </span>
                {data?.modelsPath && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
                    {data.modelsPath}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 gap-1.5 text-[12px]"
                // Adding on top of a file we could not read would be a blind
                // write; the host refuses it anyway, and disabling says so
                // before the user has filled in a form.
                disabled={Boolean(customError)}
                onClick={() => setEditor({ id: null })}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('common.add', '添加')}
              </Button>
            </div>
            {customError ? (
              <div className="flex items-start gap-2 px-4 py-4 text-[12.5px]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span className="text-foreground">{customError}</span>
              </div>
            ) : customIds.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                {t(
                  'settings.piLlm.noCustomProviders',
                  '接入 Ollama、vLLM、LM Studio 或任何 OpenAI 兼容的自建服务。',
                )}
              </p>
            ) : (
              <ul className="divide-y divide-border-soft">
                {customIds.map((id) => {
                  const entry = custom[id]
                  const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : ''
                  const models = Array.isArray(entry.models) ? entry.models.length : 0
                  return (
                    <li key={id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[12.5px] text-foreground">
                            {typeof entry.name === 'string' && entry.name ? entry.name : id}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-faint">{id}</span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                          {baseUrl}
                          {models > 0 &&
                            ` · ${t('settings.piLlm.modelCount', '{{count}} 个模型', {
                              count: models,
                            })}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={t('common.edit', '编辑')}
                          onClick={() => setEditor({ id })}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={t('common.delete', '删除')}
                          disabled={busyProvider === id}
                          onClick={() => void handleDeleteCustom(id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </SettingCard>

          {data?.authPath && (
            <p className="px-1 text-[11px] leading-relaxed text-faint">
              {t('settings.piLlm.authPathHint', '凭证保存在 {{path}}。', { path: data.authPath })}
            </p>
          )}
        </div>
      )}

      {login && (
        <PiLoginDialog
          open
          providerId={login.providerId}
          providerName={login.providerName}
          authType={login.authType}
          workspaceId={workspaceId}
          onClose={() => setLogin(null)}
          onFinished={() => void load()}
        />
      )}

      {editor && (
        <PiCustomProviderDialog
          open
          editingId={editor.id}
          initialProvider={editor.id ? (custom[editor.id] ?? null) : null}
          existingIds={customIds}
          onClose={() => setEditor(null)}
          onSave={async (id, provider) => {
            await putPiCustomProvider(id, provider, workspaceId)
            await load()
          }}
        />
      )}
    </div>
  )
}

/** One provider: what it offers, what it is using, and the actions for it. */
function ProviderRow({
  provider,
  busy,
  onLogin,
  onLogout,
}: {
  provider: PiProvider
  busy: boolean
  onLogin: (authType: PiAuthType) => void
  onLogout: () => void
}) {
  const { t } = useTranslation()
  const loginable = provider.methods.filter((m) => m.canLogin)
  // pi resolves these from an AWS profile, Vertex ADC or a plain environment
  // variable; there is nothing to collect, so the row says so instead of
  // offering a key field that pi would ignore.
  const ambientOnly = loginable.length === 0

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] text-foreground">{provider.name}</span>
          {provider.configured && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
          {provider.isSubscription && (
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Sparkles className="h-2.5 w-2.5" />
              {t('settings.piLlm.subscription', '订阅')}
            </span>
          )}
          {provider.custom && (
            <span className="shrink-0 rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t('settings.piLlm.customBadge', '自定义')}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          <span className="font-mono">{provider.id}</span>
          {provider.availableModelCount > 0 &&
            ` · ${t('settings.piLlm.modelCount', '{{count}} 个模型', {
              count: provider.availableModelCount,
            })}`}
          {provider.configured && ` · ${sourceLabel(provider, t)}`}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {ambientOnly ? (
          <span className="text-[11px] text-faint">
            {t('settings.piLlm.ambientOnly', '由环境变量提供')}
          </span>
        ) : (
          loginable.map((method) => (
            <Button
              key={method.authType}
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              disabled={busy}
              // pi's own name for the method — "Anthropic (Claude Pro/Max)",
              // "Kimi For Coding". Only three providers ship a short
              // `loginLabel`, so for the rest this tooltip is the only place
              // the distinction between a subscription and a key is spelled
              // out, and it is too long to sit on a button in a dense row.
              title={method.name}
              onClick={() => onLogin(method.authType)}
            >
              {method.authType === 'oauth' ? (
                <LogIn className="h-3.5 w-3.5" />
              ) : (
                <KeyRound className="h-3.5 w-3.5" />
              )}
              {method.authType === 'oauth'
                ? (method.loginLabel ?? t('settings.piLlm.signIn', '登录'))
                : t('settings.piLlm.useApiKey', 'API Key')}
            </Button>
          ))
        )}
        {/* Only a stored credential is ours to remove — an environment
            variable or a models.json key survives a logout, so offering one
            would promise something it cannot deliver. */}
        {provider.configured && provider.source === 'stored' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            disabled={busy}
            onClick={onLogout}
          >
            <LogOut className="h-3.5 w-3.5" />
            {t('settings.piLlm.signOut', '退出')}
          </Button>
        )}
      </div>
    </li>
  )
}

function sourceLabel(provider: PiProvider, t: (key: string, fallback: string) => string): string {
  switch (provider.source) {
    case 'stored':
      return provider.credentialType === 'oauth'
        ? t('settings.piLlm.sourceOauth', '已登录')
        : t('settings.piLlm.sourceStored', '已保存 API Key')
    case 'environment':
      return provider.label ?? t('settings.piLlm.sourceEnv', '环境变量')
    case 'models_json_key':
    case 'models_json_command':
      return t('settings.piLlm.sourceModelsJson', 'models.json')
    case 'runtime':
      return t('settings.piLlm.sourceRuntime', '运行时提供')
    default:
      return provider.label ?? t('settings.piLlm.sourceConfigured', '已配置')
  }
}
