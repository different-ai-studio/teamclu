import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, Bot, Loader2, RefreshCw, RotateCcw, Save, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useCurrentTeamStore } from '@/stores/current-team'
import {
  getLocalDaemonAgent,
  getDaemonVersion,
  listAgentAccess,
  listTeamMembersForAccess,
  removeAgentAccess,
  updateCurrentDaemonAgent,
  upsertAgentAccess,
  type AgentAccessRow,
  type AgentPermissionLevel,
  type AgentVisibility,
  type CurrentDaemonAgent,
  type TeamMemberOption,
} from '@/lib/daemon/daemon-agent-admin'
import {
  encodeWorkspaceId,
  getCursorAgentSettings,
  getDaemonLocalAgent,
  reloadDaemonRuntime,
  setDaemonLocalAgent,
  type DaemonLocalAgent,
} from '@/lib/daemon/daemon-local-client'
import { describeEnvReloadOutcome } from '@/lib/agent/env-runtime-reload'
import { useUIStore } from '@/stores/ui'
import { useSetupStore } from '@/stores/setup'
import { ensureLocalDaemonCatalog } from '@/stores/local-daemon-catalog-store'
import { useWorkspaceStore } from '@/stores/workspace'
import { ensureAgentsSkillsPaths } from '@/lib/skills/ensure-agents-paths'
import { useDaemonMqttConnected } from '@/stores/daemon-mqtt-status'
import { cn, isTauri } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { SectionHeader, SettingCard } from './shared'
import { DaemonManualResetCard } from './DaemonManualResetCard'
import { TeamSecretEntry } from './team/TeamSecretEntry'

const permissionLevels: AgentPermissionLevel[] = ['view', 'prompt', 'admin']

function formatRelative(value: string | null): string {
  if (!value) return '-'
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return value
  const diff = Date.now() - time
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function DaemonGeneralSection() {
  const { t } = useTranslation()
  const team = useCurrentTeamStore((s) => s.team)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const [agent, setAgent] = React.useState<CurrentDaemonAgent | null>(null)
  const [accessRows, setAccessRows] = React.useState<AgentAccessRow[]>([])
  const [members, setMembers] = React.useState<TeamMemberOption[]>([])
  const [displayName, setDisplayName] = React.useState('')
  const [visibility, setVisibility] = React.useState<AgentVisibility>('team')
  const [memberId, setMemberId] = React.useState('')
  const [permissionLevel, setPermissionLevel] = React.useState<AgentPermissionLevel>('prompt')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [daemonTeamId, setDaemonTeamId] = React.useState<string | null>(null)
  // Shared with the sidebar status dot — one poll, one value (#522).
  const daemonMqttConnected = useDaemonMqttConnected()
  const [daemonVersion, setDaemonVersion] = React.useState<string | null>(null)
  // Local agent runtime (`agents.local_agent`): opencode | pi. Switching writes
  // the daemon config and restarts amuxd so the new backend takes effect.
  const [localAgent, setLocalAgentState] = React.useState<DaemonLocalAgent | null>(null)
  const [switchingAgent, setSwitchingAgent] = React.useState(false)
  const [cursorKeyConfigured, setCursorKeyConfigured] = React.useState<boolean | null>(null)
  // When set, render the existing daemon onboarding wizard as an overlay to
  // re-bind the local daemon to the current team.
  const [rebinding, setRebinding] = React.useState(false)
  const [forceReloadOpen, setForceReloadOpen] = React.useState(false)
  const [forceReloading, setForceReloading] = React.useState(false)
  const forceReloadInFlightRef = React.useRef(false)
  // Surfaced so the overlay can offer a safe cancel *before* the daemon binding
  // is cleared (status 'mismatch'); once re-init starts there's no going back.
  const onboardingStatus = useDaemonOnboardingStore((s) => s.status)
  const onboardingBusy = useDaemonOnboardingStore((s) => s.busy)
  // Cloud-session auto-heal: when the daemon's refresh token is terminally
  // rejected it can't advertise its backends — detect it here and re-onboard.
  const cloudAuthExpired = useDaemonOnboardingStore((s) => s.cloudAuthExpired)
  const healing = useDaemonOnboardingStore((s) => s.healing)
  const healError = useDaemonOnboardingStore((s) => s.healError)
  const checkCloudSession = useDaemonOnboardingStore((s) => s.checkCloudSession)
  const autoHealCloudSession = useDaemonOnboardingStore((s) => s.autoHealCloudSession)
  const daemonGeneralPrompt = useUIStore((s) => s.daemonGeneralPrompt)
  const clearDaemonGeneralPrompt = useUIStore((s) => s.clearDaemonGeneralPrompt)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  // The local daemon is single-team (its team_id is fixed at `amuxd init`).
  // Read it so we can warn when it diverges from the app's selected team —
  // team-share content syncs/links under the daemon's team, not the app's.
  const loadDaemonTeamId = React.useCallback(async () => {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const id = await invoke<string | null>('get_daemon_team_id')
      setDaemonTeamId(id ?? null)
    } catch {
      // Best-effort: no daemon config / not onboarded → no warning.
    }
  }, [])

  React.useEffect(() => {
    void loadDaemonTeamId()
  }, [loadDaemonTeamId])

  const loadLocalAgent = React.useCallback(async () => {
    if (!isTauri()) return
    try {
      setLocalAgentState(await getDaemonLocalAgent())
    } catch {
      // Daemon unreachable / not onboarded — leave unknown, the row hides.
    }
  }, [])

  React.useEffect(() => {
    void loadLocalAgent()
  }, [loadLocalAgent])

  // Which runtimes are actually installed on this device. The picker writes a
  // per-team value, so a team can name a runtime this machine does not have —
  // that combination only failed at spawn time before, as a raw ENOENT.
  const agentRuntimes = useSetupStore((s) => s.agentRuntimes)
  const listAgentRuntimes = useSetupStore((s) => s.listAgentRuntimes)

  React.useEffect(() => {
    void listAgentRuntimes()
  }, [listAgentRuntimes])

  const runtimeInstalled = React.useCallback(
    (id: DaemonLocalAgent): boolean | null => {
      const row = agentRuntimes.find((r) => r.id === id)
      return row ? row.present : null
    },
    [agentRuntimes],
  )

  /**
   * The short badge for an unusable runtime. "Not installed" is only the truth
   * when nothing more specific came back: cursor is ready when node + our
   * bridge + the SDK + an API key all line up, and pi when node + its own
   * version + the MCP bridge do — reporting any of those as "not installed"
   * sent people off to install a CLI that was already there.
   */
  const runtimeBlockerLabel = React.useCallback(
    (id: DaemonLocalAgent): string => {
      switch (agentRuntimes.find((r) => r.id === id)?.blocker) {
        case 'api_key':
          return t('settings.daemonGeneral.runtimeNeedsApiKey', '缺 API Key')
        case 'node':
          return t('settings.daemonGeneral.runtimeNeedsNode', '缺 node')
        case 'node_outdated':
          return t('settings.daemonGeneral.runtimeNodeOutdated', 'node 版本太低')
        case 'mcp_sdk':
          return t('settings.daemonGeneral.runtimeMcpSdkMissing', '缺 MCP 桥')
        case 'bridge':
          return t('settings.daemonGeneral.runtimeBridgeMissing', '桥接未就绪')
        default:
          return t('settings.daemonGeneral.runtimeNotInstalled', '未安装')
      }
    },
    [agentRuntimes, t],
  )

  /**
   * The versions behind the badge: which node we found and which one is needed.
   * The badge alone ("node 版本太低") is still a hunt on a machine with three
   * Nodes installed — this names the file we measured.
   */
  const runtimeBlockerDetail = React.useCallback(
    (id: DaemonLocalAgent): string | null => {
      const row = agentRuntimes.find((r) => r.id === id)
      if (!row?.blockerRequired) return null
      return row.blockerFound
        ? t(
            'settings.daemonGeneral.runtimeBlockerFound',
            '找到的是 {{found}}，需要 {{required}} 或更高版本。',
            { found: row.blockerFound, required: row.blockerRequired },
          )
        : t('settings.daemonGeneral.runtimeBlockerNeeds', '需要 {{required}} 或更高版本。', {
            required: row.blockerRequired,
          })
    },
    [agentRuntimes, t],
  )

  const selectedRuntimeMissing = localAgent !== null && runtimeInstalled(localAgent) === false
  const selectedRuntimeBlocker =
    localAgent !== null ? (agentRuntimes.find((r) => r.id === localAgent)?.blocker ?? null) : null

  React.useEffect(() => {
    if (!isTauri() || localAgent !== 'cursor') {
      setCursorKeyConfigured(null)
      return
    }
    void getCursorAgentSettings()
      .then((s) => setCursorKeyConfigured(s.apiKeyConfigured))
      .catch(() => setCursorKeyConfigured(null))
  }, [localAgent])

  // Switch the local runtime: persist `agents.local_agent`, restart amuxd, then
  // re-poll until the daemon comes back reporting the new runtime. The daemon
  // mints a fresh HTTP token on restart; daemonFetch re-exchanges it on 401.
  const handleSwitchLocalAgent = React.useCallback(
    async (next: DaemonLocalAgent) => {
      if (next === localAgent || switchingAgent) return
      setSwitchingAgent(true)
      setError(null)
      const previous = localAgent
      setLocalAgentState(next) // optimistic
      try {
        await setDaemonLocalAgent(next)
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('restart_local_daemon')
        // Poll for the daemon to come back with the new runtime (bounded).
        let confirmed = false
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500))
          try {
            const current = await getDaemonLocalAgent()
            if (current === next) {
              confirmed = true
              break
            }
          } catch {
            // still restarting
          }
        }
        if (!confirmed) {
          setError(
            t(
              'settings.daemonGeneral.switchTimeout',
              'Switched runtime, but the daemon did not confirm in time. It may still be restarting.',
            ),
          )
        }
        setLocalAgentState(next)
        // Warm the new backend's model catalog before the user goes back to the
        // conversation. The restart above empties the daemon's process pool, so
        // the next catalog read is a cold probe — and for claude-code that probe
        // has to start a session to get an answer at all. Doing it here, while
        // the switch is still on screen, is what keeps the agent pill from
        // showing "Offline" and then "No model configured" until a restart.
        //
        // `force` because the cached entry describes the backend being left.
        // Fire-and-forget: a failure here costs a slower first pill, not a
        // failed switch, and the periodic refresh retries anyway.
        const workspacePath = useWorkspaceStore.getState().workspacePath?.trim()
        if (workspacePath) {
          ensureLocalDaemonCatalog(workspacePath, next, { force: true })
        }
        // Point Claude / OpenCode skills.paths at ~/.agents/skills for the
        // newly selected runtime (and refresh workspace configs when open).
        void ensureAgentsSkillsPaths(workspacePath)
      } catch (e) {
        setLocalAgentState(previous) // revert on failure
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSwitchingAgent(false)
      }
    },
    [localAgent, switchingAgent, t],
  )

  const teamMismatch = !!daemonTeamId && !!team?.id && daemonTeamId !== team.id

  const load = React.useCallback(async () => {
    if (!team?.id) return
    setLoading(true)
    setError(null)
    try {
      const nextAgent = await getLocalDaemonAgent(team.id)
      setAgent(nextAgent)
      if (nextAgent) clearDaemonGeneralPrompt()
      setDisplayName(nextAgent?.displayName ?? '')
      setVisibility(nextAgent?.visibility ?? 'team')
      const [nextMembers, nextAccessRows] = await Promise.all([
        listTeamMembersForAccess(team.id),
        nextAgent ? listAgentAccess(nextAgent.id) : Promise.resolve([]),
      ])
      setMembers(nextMembers)
      setAccessRows(nextAccessRows)
      setMemberId((current) => nextMembers.some((member) => member.id === current) ? current : nextMembers[0]?.id ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [team?.id, clearDaemonGeneralPrompt])

  React.useEffect(() => {
    void load()
  }, [load])

  // The running daemon's own version (from GET /v1/info). Fetched once — it only
  // changes across a daemon restart/upgrade, which reopens this section anyway.
  React.useEffect(() => {
    void getDaemonVersion().then(setDaemonVersion)
  }, [])

  // Opening this section is the moment the misleading "no backends advertised"
  // copy appears — probe the daemon's cloud session here too so a session that
  // died after startup is detected (and auto-healed) without an app restart.
  React.useEffect(() => {
    void checkCloudSession()
  }, [checkCloudSession])

  const handleSaveProfile = async () => {
    if (!agent || !displayName.trim()) return
    setSaving(true)
    setError(null)
    try {
      await updateCurrentDaemonAgent({
        agentId: agent.id,
        displayName: displayName.trim(),
        visibility,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleAddAccess = async () => {
    if (!agent || !memberId) return
    setSaving(true)
    setError(null)
    try {
      await upsertAgentAccess({
        agentId: agent.id,
        memberId,
        permissionLevel,
        grantedByMemberId: currentMember?.id ?? null,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateAccess = async (row: AgentAccessRow, nextLevel: AgentPermissionLevel) => {
    setSaving(true)
    setError(null)
    try {
      await upsertAgentAccess({
        agentId: row.agentId,
        memberId: row.memberId,
        permissionLevel: nextLevel,
        grantedByMemberId: currentMember?.id ?? row.grantedByMemberId,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRemoveAccess = async (row: AgentAccessRow) => {
    setSaving(true)
    setError(null)
    try {
      await removeAgentAccess(row.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!team) {
    return (
      <div className="space-y-6">
        <SectionHeader
          icon={Bot}
          title={t('settings.daemonGeneral.title', 'General')}
          description={t('settings.daemonGeneral.description', 'Maintain this machine daemon agent and access')}
          iconColor="text-slate-500"
        />
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.daemonGeneral.noTeam', 'Join or create a team before configuring daemon agent settings.')}
          </p>
        </SettingCard>
      </div>
    )
  }

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader
          icon={Bot}
          title={t('settings.daemonGeneral.title', 'General')}
          description={t('settings.daemonGeneral.description', 'Maintain this machine daemon agent and access')}
          iconColor="text-slate-500"
        />
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={load} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('common.refresh', 'Refresh')}
        </Button>
      </div>

      {error && (
        <SettingCard className="border-destructive/20 bg-destructive/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="text-[13px] font-medium text-destructive">{t('common.error', 'Error')}</p>
              <p className="mt-1 break-words text-[13px] text-destructive/80">{error}</p>
            </div>
          </div>
        </SettingCard>
      )}

      {daemonGeneralPrompt === 'quick_chat' && !agent && !loading && (
        <SettingCard className="border-coral/25 bg-coral-soft/40">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-coral" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-[13px] font-medium text-foreground">
                {t('settings.daemonGeneral.quickChatBlockedTitle', '无法一键开聊')}
              </p>
              <p className="text-[12px] leading-5 text-muted-foreground">
                {t(
                  'settings.daemonGeneral.quickChatBlockedDesc',
                  '本机 Agent 尚未加入当前团队。完成下方绑定后，即可使用侧边栏的「新聊天」与本机 Agent 开聊。',
                )}
              </p>
              <div className="pt-1">
                <Button
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => {
                    clearDaemonGeneralPrompt()
                    setRebinding(true)
                  }}
                >
                  <Bot className="h-3.5 w-3.5" />
                  {t('settings.daemonGeneral.bindLocalAgent', '绑定本机 Agent')}
                </Button>
              </div>
            </div>
          </div>
        </SettingCard>
      )}

      {teamMismatch && (
        <SettingCard className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-[13px] font-medium text-amber-700 dark:text-amber-400">
                {t('settings.daemonGeneral.teamMismatchTitle', '本机 Daemon 与当前团队不一致')}
              </p>
              <p className="text-[12px] leading-5 text-amber-700/80 dark:text-amber-400/80">
                {t(
                  'settings.daemonGeneral.teamMismatchDesc',
                  'Daemon 绑定的团队与 App 当前选中的团队不同。团队共享内容会同步并软链到 Daemon 的团队，而非当前团队。如需让本机参与当前团队的共享，请用当前团队的邀请重新初始化 Daemon。',
                )}
              </p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-0.5 pt-0.5 text-[11px]">
                <dt className="text-amber-700/70 dark:text-amber-400/70">
                  {t('settings.daemonGeneral.daemonTeam', 'Daemon 团队')}
                </dt>
                <dd className="truncate font-mono text-amber-800 dark:text-amber-300">{daemonTeamId}</dd>
                <dt className="text-amber-700/70 dark:text-amber-400/70">
                  {t('settings.daemonGeneral.currentTeam', '当前团队')}
                </dt>
                <dd className="truncate font-mono text-amber-800 dark:text-amber-300">{team.id}</dd>
              </dl>
              <div className="pt-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                  onClick={() => setRebinding(true)}
                  disabled={rebinding}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('settings.daemonGeneral.rebind', '重新绑定到当前团队')}
                </Button>
              </div>
            </div>
          </div>
        </SettingCard>
      )}

      {cloudAuthExpired && (
        <SettingCard className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            {healing ? (
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <div className="min-w-0 space-y-1.5">
              <p className="text-[13px] font-medium text-amber-700 dark:text-amber-400">
                {t('settings.daemonGeneral.cloudExpiredTitle', '本机 Daemon 云端会话已过期')}
              </p>
              <p className="text-[12px] leading-5 text-amber-700/80 dark:text-amber-400/80">
                {healing
                  ? t(
                      'settings.daemonGeneral.cloudExpiredReconnecting',
                      '正在自动重新连接 Daemon（重新签发凭证并重启）…',
                    )
                  : healError
                    ? healError
                    : t(
                        'settings.daemonGeneral.cloudExpiredDesc',
                        'Daemon 的登录凭证已失效，无法上报后端类型或同步。正在尝试自动重新连接。',
                      )}
              </p>
              {!healing && (
                <div className="pt-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                    onClick={() => void autoHealCloudSession()}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t('settings.daemonGeneral.reconnect', '重新连接')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </SettingCard>
      )}

      {/* Team env encryption key for amuxd — lives here (not Team Share) because
          the secret is delivered to the local daemon, not the share sync path. */}
      {isTauri() && team.id && workspacePath?.trim() && (
        <SettingCard>
          <div className="space-y-3">
            <div>
              <p className="text-[13px] font-semibold">
                {t('settings.teamSecret.updateSectionTitle')}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {t('settings.teamSecret.updateSectionDesc')}
              </p>
            </div>
            <TeamSecretEntry
              teamId={daemonTeamId || team.id}
              workspacePath={workspacePath.trim()}
              allowGenerate
            />
          </div>
        </SettingCard>
      )}

      {loading && !agent ? (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      ) : !agent ? (
        <SettingCard>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.daemonGeneral.noAgent', 'No daemon agent is associated with this machine yet.')}
          </p>
          {daemonGeneralPrompt !== 'quick_chat' && (
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => setRebinding(true)}
              >
                <Bot className="h-3.5 w-3.5" />
                {t('settings.daemonGeneral.bindLocalAgent', '绑定本机 Agent')}
              </Button>
            </div>
          )}
        </SettingCard>
      ) : (
        <>
          <SettingCard>
            <div className="space-y-3">
              <p className="text-[13px] font-semibold">{t('settings.daemonGeneral.mqttSection', 'MQTT 连接')}</p>
              <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[12px]">
                <dt className="text-muted-foreground">{t('settings.daemonGeneral.mqttStatus', 'Status')}</dt>
                <dd className="flex items-center gap-2">
                  <span className={cn('inline-block h-2 w-2 rounded-full', daemonMqttConnected === true ? 'bg-emerald-500' : daemonMqttConnected === false ? 'bg-amber-400' : 'bg-muted-foreground/40')} />
                  <span className="text-foreground">
                    {daemonMqttConnected === true
                      ? t('settings.daemonGeneral.mqttConnected', 'Connected')
                      : daemonMqttConnected === false
                        ? t('settings.daemonGeneral.mqttDisconnected', 'Disconnected')
                        : t('settings.daemonGeneral.mqttUnknown', 'Unknown')}
                  </span>
                </dd>
              </dl>
            </div>
          </SettingCard>
          <SettingCard>
            <div className="space-y-5">
              <div>
                <p className="text-[13px] font-semibold">{t('settings.daemonGeneral.basicInfo', 'Agent info')}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.daemonGeneral.basicInfoDesc', 'This is the daemon agent running on this machine.')}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('settings.daemonGeneral.displayName', 'Display name')}</span>
                  <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={saving || !agent.isOwner} />
                </label>
                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-muted-foreground">{t('settings.daemonGeneral.visibility', 'Visibility')}</span>
                  <label className="flex h-9 items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={visibility === 'team'}
                      onChange={(event) => setVisibility(event.target.checked ? 'team' : 'personal')}
                      disabled={saving || !agent.isOwner}
                      className="h-4 w-4 shrink-0 rounded-[5px] border-border accent-coral disabled:opacity-60"
                    />
                    <span className="text-[13px] text-foreground">{t('settings.daemonGeneral.shareWithTeam', 'Share with the team')}</span>
                  </label>
                </div>
              </div>

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-2.5 border-t border-border-soft pt-4 text-[12px]">
                {/* Local agent runtime picker (`agents.local_agent`). Switching
                    persists the config and restarts amuxd onto the new backend. */}
                <dt className="text-muted-foreground">{t('settings.daemonGeneral.runtime', 'Runtime')}</dt>
                <dd className="flex items-center gap-2">
                  <Select
                    value={localAgent ?? undefined}
                    onValueChange={(v) => void handleSwitchLocalAgent(v as DaemonLocalAgent)}
                    disabled={switchingAgent || !agent.isOwner || localAgent === null}
                  >
                    <SelectTrigger className="h-7 w-[140px] font-mono text-[12px]" data-testid="local-agent-select">
                      {/* Children override the selected item's own markup, which
                          would otherwise drag the "not installed" badge into the
                          trigger and truncate it. The badge belongs in the list;
                          the warning row below carries it for the selection. */}
                      <SelectValue placeholder="…">{localAgent}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(['opencode', 'pi', 'cursor', 'claude-code'] as DaemonLocalAgent[]).map((id) => {
                        const installed = runtimeInstalled(id)
                        // `installed` no longer folds in cursor's API key, so a
                        // blocker can outlive it: the runtime is here and
                        // pickable, and still cannot answer until the key is in.
                        const blocked = installed === false || !!agentRuntimes.find((r) => r.id === id)?.blocker
                        return (
                          <SelectItem key={id} value={id} className="font-mono text-[12px]">
                            <span className="flex items-center gap-2">
                              {id}
                              {blocked && (
                                <span className="font-sans text-[10.5px] text-muted-foreground">
                                  {runtimeBlockerLabel(id)}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                  {switchingAgent && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                </dd>
                {/* `agents.local_agent` lives in the active team's team.toml, not
                    daemon.toml — switching teams switches runtimes. Say so here,
                    since the surrounding card reads as machine-level. */}
                <dt className="sr-only">{t('settings.daemonGeneral.runtimeScope', 'Runtime scope')}</dt>
                <dd className="col-span-2 -mt-1 text-[11.5px] leading-relaxed text-faint">
                  {t(
                    'settings.daemonGeneral.runtimePerTeamHint',
                    'The runtime is configured per team — this setting applies to {{team}} only.',
                    { team: team?.name ?? t('settings.daemonGeneral.runtimeCurrentTeam', 'the current team') },
                  )}
                </dd>
                {selectedRuntimeMissing && (
                  <>
                    <dt className="sr-only">{t('settings.daemonGeneral.runtimeMissing', 'Runtime missing')}</dt>
                    <dd className="col-span-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-coral">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        {selectedRuntimeBlocker
                          ? [
                              t(
                                'settings.daemonGeneral.runtimeBlockedHint',
                                '{{agent}} 还不能用：{{reason}}。在此之前，这个团队的 agent 无法启动。',
                                { agent: localAgent, reason: runtimeBlockerLabel(localAgent as DaemonLocalAgent) },
                              ),
                              runtimeBlockerDetail(localAgent as DaemonLocalAgent),
                            ]
                              .filter(Boolean)
                              .join(' ')
                          : t(
                              'settings.daemonGeneral.runtimeMissingHint',
                              '{{agent}} is not installed on this machine, so agents in this team cannot start. Pick a runtime that is installed, or install {{agent}} first.',
                              { agent: localAgent },
                            )}
                      </span>
                    </dd>
                  </>
                )}
                {localAgent === 'cursor' && cursorKeyConfigured === false ? (
                  <>
                    <dt className="sr-only">Cursor</dt>
                    <dd className="col-span-2 text-[11.5px] leading-relaxed text-coral">
                      {t(
                        'settings.daemonGeneral.cursorKeyHint',
                        'Cursor 运行时需在「设置 → LLM」中配置 API Key，无需编辑 daemon.toml。',
                      )}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{t('settings.daemonGeneral.agentId', 'Agent ID')}</dt>
                <dd className="truncate font-mono text-foreground">{agent.id}</dd>
                <dt className="text-muted-foreground">{t('settings.daemonGeneral.lastActive', 'Last active')}</dt>
                <dd className="font-mono text-ink-2">{formatRelative(agent.lastActiveAt)}</dd>
                <dt className="text-muted-foreground">{t('settings.daemonGeneral.daemonVersion', 'Daemon version')}</dt>
                <dd className="font-mono text-ink-2">{daemonVersion ? `v${daemonVersion}` : '—'}</dd>
              </dl>

              <div className="flex items-center gap-3 border-t border-border-soft pt-4">
                <Button size="sm" className="gap-1.5" onClick={handleSaveProfile} disabled={saving || !agent.isOwner || !displayName.trim()}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {t('common.save', 'Save')}
                </Button>
                {!agent.isOwner && (
                  <p className="text-[11px] text-faint">
                    {t('settings.daemonGeneral.ownerOnly', 'Only the agent owner can edit profile and access settings.')}
                  </p>
                )}
              </div>
            </div>
          </SettingCard>

          <SettingCard>
            <div className="space-y-5">
              <div>
                <p className="text-[13px] font-semibold">{t('settings.daemonGeneral.accessTitle', 'Member access')}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.daemonGeneral.accessDesc', 'Rows are read from agent_member_access for this daemon agent.')}</p>
              </div>

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
                <Select
                  value={memberId || undefined}
                  onValueChange={setMemberId}
                  disabled={saving || !agent.isOwner || members.length === 0}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder={t('settings.daemonGeneral.selectMember', 'Select member')} />
                  </SelectTrigger>
                  <SelectContent>
                    {members.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={permissionLevel}
                  onValueChange={(value) => setPermissionLevel(value as AgentPermissionLevel)}
                  disabled={saving || !agent.isOwner}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {permissionLevels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" className="h-11 gap-1.5" onClick={handleAddAccess} disabled={saving || !agent.isOwner || !memberId}>
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('settings.daemonGeneral.addAccess', 'Add')}
                </Button>
              </div>

              <div className="space-y-2">
                {accessRows.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">{t('settings.daemonGeneral.noAccess', 'No member access rows yet.')}</p>
                ) : accessRows.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-border-soft bg-background/40 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[13px] text-foreground">{row.memberName}</p>
                      <code className="block truncate font-mono text-[11px] text-faint">{row.memberId}</code>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select
                        value={row.permissionLevel}
                        onValueChange={(value) => handleUpdateAccess(row, value as AgentPermissionLevel)}
                        disabled={saving || !agent.isOwner}
                      >
                        <SelectTrigger className="h-9 w-[120px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {permissionLevels.map((level) => (
                            <SelectItem key={level} value={level}>
                              {level}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive" onClick={() => handleRemoveAccess(row)} disabled={saving || !agent.isOwner || row.memberId === agent.id}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </SettingCard>
        </>
      )}

      {isTauri() && workspacePath?.trim() && (
        <SettingCard>
          <div className="space-y-3">
            <div>
              <p className="text-[13px] font-semibold">
                {t('settings.daemonGeneral.forceReloadTitle', '强制重载 Agent 运行时')}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {t(
                  'settings.daemonGeneral.forceReloadDesc',
                  '环境变量等变更一般会在空闲后自动生效。仅在急需时使用强制重载。',
                )}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              disabled={forceReloading}
              data-testid="daemon-force-reload-runtime"
              onClick={() => setForceReloadOpen(true)}
            >
              {forceReloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {t('settings.daemonGeneral.forceReloadButton', '强制重载')}
            </Button>
          </div>
        </SettingCard>
      )}

      {isTauri() && (
        <DaemonManualResetCard onResetComplete={() => setRebinding(true)} />
      )}
    </div>

      <AlertDialog
        open={forceReloadOpen}
        onOpenChange={(open) => {
          if (!forceReloadInFlightRef.current) setForceReloadOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.daemonGeneral.forceReloadConfirmTitle', '确认强制重载运行时？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.daemonGeneral.forceReloadConfirmDesc',
                '将停止本工作区活跃的 Agent runtime，并重启全局 OpenCode serve。进行中的回复可能中断；之后需再发消息或新建会话才会使用最新环境变量。一般情况下可等待空闲后自动生效。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceReloading}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="daemon-force-reload-confirm"
              disabled={forceReloading}
              onClick={(event) => {
                event.preventDefault()
                if (forceReloadInFlightRef.current) return
                forceReloadInFlightRef.current = true
                void (async () => {
                  const path = workspacePath?.trim()
                  if (!path) {
                    toast.error(t('settings.daemonGeneral.forceReloadNoWorkspace', '未选择工作区'))
                    forceReloadInFlightRef.current = false
                    setForceReloadOpen(false)
                    return
                  }
                  setForceReloading(true)
                  try {
                    const outcome = await reloadDaemonRuntime(encodeWorkspaceId(path))
                    setForceReloadOpen(false)
                    if (!outcome) {
                      toast.error(t('settings.daemonGeneral.forceReloadFailed', '重载失败'), {
                        description: t(
                          'settings.daemonGeneral.forceReloadDaemonUnavailable',
                          '本地 amuxd 不可用。',
                        ),
                      })
                      return
                    }
                    toast.success(t('settings.daemonGeneral.forceReloadDone', '运行时已重载'), {
                      description: describeEnvReloadOutcome(outcome),
                    })
                  } catch (err) {
                    toast.error(t('settings.daemonGeneral.forceReloadFailed', '重载失败'), {
                      description: err instanceof Error ? err.message : String(err),
                    })
                  } finally {
                    forceReloadInFlightRef.current = false
                    setForceReloading(false)
                  }
                })()
              }}
            >
              {forceReloading ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('settings.daemonGeneral.forceReloading', '正在重载…')}
                </>
              ) : (
                t('settings.daemonGeneral.forceReloadConfirmAction', '确认重载')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {rebinding && (
        <div className="fixed inset-0 z-50">
          {onboardingStatus === 'mismatch' && !onboardingBusy && (
            <button
              type="button"
              onClick={() => setRebinding(false)}
              className="absolute right-5 top-5 z-10 rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-panel hover:text-foreground"
            >
              {t('common.cancel', '取消')}
            </button>
          )}
          <DaemonOnboardingWizard
            onDone={() => {
              setRebinding(false)
              clearDaemonGeneralPrompt()
              // Daemon is now bound to the current team — clear the warning and
              // reload the agent profile/access for the freshly-bound team.
              void loadDaemonTeamId()
              void load()
            }}
          />
        </div>
      )}
    </>
  )
}
