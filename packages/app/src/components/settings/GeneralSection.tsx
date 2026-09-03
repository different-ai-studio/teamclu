import * as React from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import {
  Settings2,
  Moon,
  Sun,
  Monitor,
  Languages,
  Bell,
  Server,
  User,
  Bug,
  PanelBottom,
  TerminalSquare,
  FolderGit,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn, isTauri } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useMqttConnected } from '@/hooks/useMqttConnected'
import { useMqttReconnectStore, recoverMqttConnection } from '@/stores/mqtt-reconnect'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getBackend } from '@/lib/backend'
import { SettingCard, SectionHeader, ToggleSwitch } from './shared'
import { TeamDefaultAgentCard } from './TeamDefaultAgentCard'
import { SwitchTeamDialog } from '@/components/auth/SwitchTeamDialog'
import { useAcpDebugStore } from '@/stores/acp-debug-store'
import { useHeaderPreferencesStore } from '@/stores/header-preferences-store'
import { appStoragePrefix, buildConfig } from '@/lib/build-config'
import { NOTIFICATION_LEVEL_KEY } from '@/lib/notification-service'
import { LANGUAGE_OPTIONS, getPreferredLanguage, normalizeSupportedLanguage, persistLanguage } from '@/lib/locale'
import { changeLanguage } from '@/lib/i18n'
import { getEffectiveServerConfig, type ServerConfig } from '@/lib/server-config'
import { fetchAndApplyBootstrap } from '@/lib/bootstrap'
import { useAuthStore } from '@/stores/auth-store'

// Theme helpers
const THEME_STORAGE_KEY = `${appStoragePrefix}-theme`
const DEFAULT_THEME = buildConfig.defaults?.theme || 'system'

function applyTheme(theme: string) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else if (theme === 'light') {
    root.classList.remove('dark')
  } else {
    // system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    if (prefersDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }
}

function getStoredTheme(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

// Apply theme immediately on module load to prevent flash
applyTheme(getStoredTheme())

export const GeneralSection = React.memo(function GeneralSection() {
  const { t } = useTranslation()
  const [theme, setThemeState] = React.useState(getStoredTheme)
  const [language, setLanguage] = React.useState(() => {
    return getPreferredLanguage()
  })

  // Sync language state with i18n instance
  React.useEffect(() => {
    const handleLanguageChange = () => {
      setLanguage(i18next.language);
    };

    i18next.on('languageChanged', handleLanguageChange);
    return () => {
      i18next.off('languageChanged', handleLanguageChange);
    };
  }, []);
  // Account: the current user's own display name (editable).
  const currentMemberName = useCurrentTeamStore((s) => s.currentMember?.displayName ?? '')
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? '')
  const currentTeamName = useCurrentTeamStore((s) => s.team?.name ?? '')
  const [switchTeamOpen, setSwitchTeamOpen] = React.useState(false)
  // Org name/id aren't kept in the current-team cache; resolve them from the
  // membership list (which carries orgId/orgName) by matching the active team.
  const [orgInfo, setOrgInfo] = React.useState<{ orgId: string | null; orgName: string | null }>({
    orgId: null,
    orgName: null,
  })
  React.useEffect(() => {
    if (!currentTeamId) return
    let cancelled = false
    void (async () => {
      try {
        const teams = await getBackend().teams.listAllMyTeams()
        if (cancelled) return
        const match = teams.find((tm) => tm.id === currentTeamId)
        setOrgInfo({ orgId: match?.orgId ?? null, orgName: match?.orgName ?? null })
      } catch {
        // Best-effort: org metadata is informational only.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentTeamId])
  const renameCurrentMember = useCurrentTeamStore((s) => s.renameCurrentMember)
  const memberSaving = useCurrentTeamStore((s) => s.saving)
  const [displayNameDraft, setDisplayNameDraft] = React.useState(currentMemberName)
  // Keep the draft in sync when the member loads / changes elsewhere, but don't
  // clobber an in-progress edit.
  const [displayNameDirty, setDisplayNameDirty] = React.useState(false)
  React.useEffect(() => {
    if (!displayNameDirty) setDisplayNameDraft(currentMemberName)
  }, [currentMemberName, displayNameDirty])

  const handleSaveDisplayName = React.useCallback(async () => {
    const trimmed = displayNameDraft.trim()
    if (!trimmed || trimmed === currentMemberName) return
    const ok = await renameCurrentMember(trimmed)
    if (ok) {
      setDisplayNameDirty(false)
    } else {
      toast.error(t('settings.general.displayNameError', 'Could not update display name'))
    }
  }, [displayNameDraft, currentMemberName, renameCurrentMember, t])

  const [notificationLevel, setNotificationLevelState] = React.useState(() => {
    try {
      const stored = localStorage.getItem(NOTIFICATION_LEVEL_KEY)
      if (stored === 'all' || stored === 'important' || stored === 'mute') return stored
    } catch { /* ignore */ }
    return 'important'
  })
  const setNotificationLevel = React.useCallback((level: string) => {
    setNotificationLevelState(level)
    try { localStorage.setItem(NOTIFICATION_LEVEL_KEY, level) } catch { /* ignore */ }
  }, [])
  const acpStreamDebugEnabled = useAcpDebugStore((s) => s.enabled)
  const setAcpStreamDebugEnabled = useAcpDebugStore((s) => s.setEnabled)
  const showTerminalToggle = useHeaderPreferencesStore((s) => s.showTerminalToggle)
  const setShowTerminalToggle = useHeaderPreferencesStore((s) => s.setShowTerminalToggle)
  const showChangesTab = useHeaderPreferencesStore((s) => s.showChangesTab)
  const setShowChangesTab = useHeaderPreferencesStore((s) => s.setShowChangesTab)
  const [closePref, setClosePref] = React.useState<'ask' | 'tray' | 'quit'>('ask')
  React.useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void invoke<string | null>('get_window_close_preference')
      .then((v) => {
        if (cancelled) return
        if (v === 'tray' || v === 'quit') setClosePref(v)
        else setClosePref('ask')
      })
      .catch(() => { /* ignore */ })
    return () => {
      cancelled = true
    }
  }, [])
  const handleClosePrefChange = React.useCallback(async (value: string) => {
    const next = value === 'tray' || value === 'quit' ? value : 'ask'
    setClosePref(next)
    try {
      await invoke('set_window_close_preference', {
        action: next === 'ask' ? null : next,
      })
    } catch {
      toast.error(t('settings.general.closeWindowError', 'Could not update close preference'))
    }
  }, [t])
  // Listen to system preference changes when theme is 'system'
  React.useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  const setTheme = React.useCallback((t: string) => {
    setThemeState(t)
    try { localStorage.setItem(THEME_STORAGE_KEY, t) } catch { /* ignore */ }
    applyTheme(t)
  }, [])

  const handleLanguageChange = React.useCallback((value: string) => {
    const normalizedValue = normalizeSupportedLanguage(value)
    setLanguage(normalizedValue)
    // Through `@/lib/i18n`, not `i18next` directly: catalogues are fetched on
    // demand (PERF-15), and only this wrapper loads the target one before
    // switching. Calling i18next straight through swaps to a locale with no
    // strings and paints raw keys.
    void changeLanguage(normalizedValue)
    persistLanguage(normalizedValue)
    void invoke('set_config_locale', { locale: normalizedValue }).catch(() => {
      // Settings should still update locally if the native config is unavailable.
    })
  }, [])

  const themeIcons: Record<string, React.ElementType> = {
    light: Sun,
    dark: Moon,
    system: Monitor,
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Settings2}
        title={t('settings.general.title', 'General')}
        description={t('settings.general.description', 'Customize your application preferences')}
        iconColor="text-blue-500"
      />

      {currentMemberName ? (
        <SettingCard>
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.displayName', 'Display Name')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.displayNameDesc', 'The name teammates see for you')}
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={displayNameDraft}
                onChange={(e) => {
                  setDisplayNameDraft(e.target.value)
                  setDisplayNameDirty(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveDisplayName()
                }}
                placeholder={t('settings.general.displayNamePlaceholder', 'Your name')}
                maxLength={60}
                className="h-11"
                data-testid="display-name-input"
              />
              <Button
                onClick={() => void handleSaveDisplayName()}
                disabled={
                  memberSaving ||
                  !displayNameDraft.trim() ||
                  displayNameDraft.trim() === currentMemberName
                }
                className="h-11 shrink-0"
              >
                {t('settings.general.save', 'Save')}
              </Button>
            </div>
          </div>
        </SettingCard>
      ) : null}

      {currentTeamId ? (
        <SettingCard>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-[13px] font-medium flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                {t('settings.general.teamInfo', 'Team & Organization')}
              </label>
              {/* The login gate restores the last team instead of asking every
                  launch, so this is the way to change teams without signing out. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSwitchTeamOpen(true)}
                className="shrink-0"
              >
                {t('settings.general.switchTeam', 'Switch team')}
              </Button>
            </div>
            <dl className="space-y-2 text-xs">
              {[
                { label: t('settings.general.teamName', 'Team name'), value: currentTeamName },
                { label: t('settings.general.teamId', 'Team ID'), value: currentTeamId },
                { label: t('settings.general.orgName', 'Org name'), value: orgInfo.orgName ?? '—' },
                { label: t('settings.general.orgId', 'Org ID'), value: orgInfo.orgId ?? '—' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground shrink-0">{row.label}</dt>
                  <dd className="font-mono text-right break-all select-text">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <SwitchTeamDialog open={switchTeamOpen} onOpenChange={setSwitchTeamOpen} />
        </SettingCard>
      ) : null}

      <TeamDefaultAgentCard />

      <SettingCard>
        <h4 className="font-medium mb-4 flex items-center gap-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          {t('settings.general.appearance', 'Appearance')}
        </h4>
        <div className="grid grid-cols-3 gap-3">
          {(['light', 'dark', 'system'] as const).map((t) => {
            const Icon = themeIcons[t]
            return (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-[14px] border p-4 transition-colors",
                  theme === t 
                    ? "border-border bg-selected text-foreground" 
                    : "border-border-soft bg-panel/60 text-muted-foreground hover:bg-selected/60 hover:text-foreground"
                )}
              >
                <Icon className={cn("h-5 w-5", theme === t ? "text-foreground" : "text-muted-foreground")} />
                <span className={cn("text-[13px] capitalize", theme === t ? "font-medium" : "text-muted-foreground")}>
                  {t}
                </span>
              </button>
            )
          })}
        </div>
      </SettingCard>

      {!import.meta.env.VITE_LOCALE || import.meta.env.VITE_LOCALE === 'all' ? (
        <SettingCard>
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <Languages className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.language', 'Language')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.languageDesc', 'Choose the app display language')}
            </p>
            <Select value={language} onValueChange={handleLanguageChange}>
              <SelectTrigger className="h-11" data-testid="language-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.value === 'en' ? '🇺🇸 ' : '🇨🇳 '}
                    {t(option.labelKey, option.fallback)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingCard>
      ) : null}

      {isTauri() ? (
        <SettingCard>
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <PanelBottom className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.closeWindow', 'When closing the window')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.general.closeWindowDesc',
                'Choose what happens when you click the window close button. Cmd+Q always quits.',
              )}
            </p>
            <Select value={closePref} onValueChange={(v) => void handleClosePrefChange(v)}>
              <SelectTrigger className="h-11" data-testid="close-window-pref-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">{t('settings.general.closeWindowAsk', 'Ask every time')}</SelectItem>
                <SelectItem value="tray">{t('settings.general.closeWindowTray', 'Minimize to tray (keep agent)')}</SelectItem>
                <SelectItem value="quit">{t('settings.general.closeWindowQuit', 'Quit and stop agent')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SettingCard>
      ) : null}

      <SettingCard>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-[13px] font-medium flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              {t('settings.general.notifications', 'Notifications')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.general.notificationsDesc',
                'Background permission alerts and other system banners (chat uses Dock bounce only)',
              )}
            </p>
            <Select value={notificationLevel} onValueChange={setNotificationLevel}>
              <SelectTrigger className="h-11" data-testid="notification-level-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('settings.general.notifAll', 'All notifications')}</SelectItem>
                <SelectItem value="important">{t('settings.general.notifImportant', 'Important only')}</SelectItem>
                <SelectItem value="mute">{t('settings.general.notifMute', 'Mute')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <label className="text-[13px] font-medium flex items-center gap-2">
                  <Bug className="h-4 w-4 text-muted-foreground" />
                  {t('settings.general.acpStreamDebug', 'ACP stream debug')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.general.acpStreamDebugDesc', 'Show live ACP event stream above the chat thread')}
                </p>
              </div>
              <ToggleSwitch
                enabled={acpStreamDebugEnabled}
                onChange={setAcpStreamDebugEnabled}
              />
            </div>
          </div>
        </div>
      </SettingCard>

      <SettingCard>
        <h4 className="font-medium mb-4 flex items-center gap-2">
          <PanelBottom className="h-4 w-4 text-muted-foreground" />
          {t('settings.general.headerIcons', '会话头部图标')}
        </h4>
        <p className="text-xs text-muted-foreground mb-4">
          {t('settings.general.headerIconsDesc', '控制会话右上角操作图标的显示。默认隐藏，需要时在此开启。')}
        </p>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <label className="text-[13px] font-medium flex items-center gap-2">
                <TerminalSquare className="h-4 w-4 text-muted-foreground" />
                {t('settings.general.showTerminalToggle', '终端开关')}
              </label>
              <p className="text-xs text-muted-foreground">
                {t('settings.general.showTerminalToggleDesc', '在会话右上角显示终端面板开关。快捷键 Ctrl+` 始终可用，不受此设置影响。')}
              </p>
            </div>
            <ToggleSwitch
              enabled={showTerminalToggle}
              onChange={setShowTerminalToggle}
            />
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <label className="text-[13px] font-medium flex items-center gap-2">
                  <FolderGit className="h-4 w-4 text-muted-foreground" />
                  {t('settings.general.showChangesTab', '文件更改')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.general.showChangesTabDesc', '在会话右上角显示本会话的文件更改入口。仅在有活跃会话时显示。')}
                </p>
              </div>
              <ToggleSwitch
                enabled={showChangesTab}
                onChange={setShowChangesTab}
              />
            </div>
          </div>
        </div>
      </SettingCard>

      <ServerAddressCard />
    </div>
  )
})

function ServerAddressCard() {
  const { t } = useTranslation()
  const [effective, setEffective] = React.useState<ServerConfig>({})

  const reload = React.useCallback(async () => {
    setEffective(await getEffectiveServerConfig())
  }, [])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const mqttConnected = useMqttConnected()
  const mqttLastError = useMqttReconnectStore((s) => s.lastError)
  const accessToken = useAuthStore((s) => s.session?.access_token ?? null)
  const [refetching, setRefetching] = React.useState(false)

  const mqttBroker = React.useMemo(() => {
    if (effective.mqttUrl) return effective.mqttUrl
    if (!effective.mqttHost) return null
    const scheme = effective.mqttUseTls ? 'mqtts' : 'mqtt'
    const port = effective.mqttPort ?? (effective.mqttUseTls ? 8883 : 1883)
    return `${scheme}://${effective.mqttHost}:${port}`
  }, [effective.mqttUrl, effective.mqttHost, effective.mqttPort, effective.mqttUseTls])

  // Ask the Cloud API for the broker again. Exposed because the two states this
  // section can land in — running on a cached address, or having none at all —
  // are both fixed on the server side, and the user needs a way to pick up the
  // fix without signing out and back in.
  const refetchBootstrap = React.useCallback(async () => {
    setRefetching(true)
    try {
      const outcome = await fetchAndApplyBootstrap({ accessToken })
      await reload()
      if (outcome === 'cloud-empty') {
        toast.error(
          t('settings.general.mqttRefetchEmpty', 'Server still returns no MQTT configuration'),
        )
      } else if (outcome !== 'applied') {
        toast.error(t('settings.general.mqttRefetchFailed', 'Could not reach the server'))
      }
    } finally {
      setRefetching(false)
    }
  }, [accessToken, reload, t])

  return (
    <SettingCard>
      <h4 className="font-medium mb-4 flex items-center gap-2">
        <Server className="h-4 w-4 text-muted-foreground" />
        {t('settings.general.server', 'Server')}
      </h4>
      <div className="space-y-1.5">
        <label className="text-[12px] font-medium text-muted-foreground">
          {t('settings.general.serverAddress', 'Server address')}
        </label>
        <p className="font-mono text-[12.5px] text-foreground break-all">
          {effective.cloudApiUrl || '—'}
        </p>
      </div>

      <div className="mt-5 space-y-2 border-t border-border-soft pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-muted-foreground">
            {t('settings.general.serverSynced', 'Synced from server')}
          </span>
          <span className="text-[11px] text-faint">
            {t('settings.general.serverSyncedHint', 'Delivered on sign-in, read-only')}
          </span>
        </div>
        {mqttBroker ? (
          <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[12px]">
            <dt className="text-muted-foreground">{t('settings.general.mqttBroker', 'MQTT broker')}</dt>
            <dd className="font-mono text-foreground break-all">
              {mqttBroker}
              {effective.mqttSource === 'cache' ? (
                <span
                  className="ml-2 rounded px-1.5 py-0.5 font-sans text-[10.5px] text-amber-700 bg-amber-500/15 dark:text-amber-400"
                  title={t(
                    'settings.general.mqttCachedHint',
                    'The server is not delivering an MQTT address; this is the last one that worked.',
                  )}
                >
                  {t('settings.general.mqttCached', 'Cached · not synced')}
                </span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">{t('settings.general.mqttStatus', 'Status')}</dt>
            <dd className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full',
                  mqttConnected === null
                    ? 'bg-faint'
                    : mqttConnected
                      ? 'bg-emerald-500'
                      : 'bg-red-500',
                )}
                aria-hidden
              />
              <span className="text-foreground">
                {mqttConnected === null
                  ? t('settings.general.mqttStatusUnknown', 'Unknown')
                  : mqttConnected
                    ? t('settings.general.mqttStatusConnected', 'Connected')
                    : t('settings.general.mqttStatusDisconnected', 'Disconnected')}
              </span>
              {mqttConnected !== true ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-[11px]"
                  onClick={() => {
                    void recoverMqttConnection()
                  }}
                >
                  {t('settings.general.mqttReconnect', 'Reconnect')}
                </Button>
              ) : null}
            </dd>
            {mqttConnected === false && mqttLastError ? (
              <>
                <dt className="text-muted-foreground">
                  {t('settings.general.mqttLastError', 'Last error')}
                </dt>
                <dd className="font-mono text-[11.5px] text-red-600 break-all dark:text-red-400">
                  {mqttLastError}
                </dd>
              </>
            ) : null}
            {effective.mqttSource === 'cache' ? (
              <>
                <dt className="text-muted-foreground">
                  {t('settings.general.mqttSource', 'Source')}
                </dt>
                <dd className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <span>
                    {t(
                      'settings.general.mqttSourceCache',
                      'Last-known address — the server is not delivering one.',
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={refetching}
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => void refetchBootstrap()}
                  >
                    {t('settings.general.mqttRefetch', 'Retry')}
                  </Button>
                </dd>
              </>
            ) : null}
          </dl>
        ) : accessToken ? (
          // Signed in but no broker anywhere: the Cloud API is answering without
          // an `mqtt` block and nothing is cached. This is a hard error, not the
          // passive "not synced yet" it used to render as — MQTT is down and no
          // amount of waiting fixes it.
          <div className="space-y-2">
            <p className="text-[12px] text-red-600 dark:text-red-400">
              {t(
                'settings.general.mqttMissingFromServer',
                'The server did not deliver an MQTT address. Real-time sync is offline until it is configured.',
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={refetching}
              className="h-6 px-2 text-[11px]"
              onClick={() => void refetchBootstrap()}
            >
              {t('settings.general.mqttRefetch', 'Retry')}
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground italic">
            {t(
              'settings.general.serverSyncedEmpty',
              'Not synced yet. Sign in once to fetch runtime configuration.',
            )}
          </p>
        )}
      </div>
    </SettingCard>
  )
}
