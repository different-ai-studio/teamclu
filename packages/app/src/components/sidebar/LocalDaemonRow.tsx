import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftRight,
  Bot,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Star,
  Trash2,
  LifeBuoy,
} from 'lucide-react'
import {
  ClaudeMark,
  CursorMark,
  OpencodeMark,
  PiAgentMark,
} from '@/components/icons/agent-brand-icons'
import { open } from '@tauri-apps/plugin-dialog'
import { toast } from 'sonner'
import type { ActorRow } from '@/stores/actor-directory-store'
import {
  listDaemonWorkspaces,
  createDaemonWorkspace,
  updateDaemonWorkspace,
  type DaemonWorkspace,
} from '@/lib/daemon-workspaces'
import { syncSessionWorkspaces } from '@/lib/session-workspace-sync'
import { amuxAgentTypeFromBackend } from '@/lib/amux-agent-type'
import { useUIStore } from '@/stores/ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { recoverMqttConnection } from '@/stores/mqtt-reconnect'
import { requestDaemonProbe } from '@/lib/daemon-probe-signal'
import { type LocalDaemonRuntimeStatus } from '@/hooks/use-local-daemon-http-status'
import { workspacePathsMatch } from '@/stores/session-utils'
import { cn } from '@/lib/utils'

interface Props {
  actor: ActorRow | null
  runtimeStatus: LocalDaemonRuntimeStatus
  isDefault?: boolean
  onViewDetail: (actor: ActorRow) => void
  onCopyName: (actor: ActorRow) => void
  onCopyId: (actor: ActorRow) => void
}

function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

function shortenActorId(actorId: string): string {
  if (actorId.length <= 12) return actorId
  return `${actorId.slice(0, 8)}…`
}

function RuntimeStatusDot({
  status,
  label,
}: {
  status: LocalDaemonRuntimeStatus
  label: string
}) {
  return (
    <span
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center self-center"
      title={label}
    >
      <span
        role="status"
        aria-label={label}
        className={cn(
          'h-[7px] w-[7px] rounded-full',
          // Green: daemon up + its MQTT up. Amber: daemon up, its MQTT down.
          // Red: daemon itself down. Grey pulse: not determined yet.
          status === 'online' && 'bg-emerald-500 shadow-[0_0_0_2px_rgba(46,184,114,0.18)]',
          status === 'daemonMqttDisconnected' &&
            'bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.22)]',
          status === 'offline' && 'bg-coral shadow-[0_0_0_2px_rgba(232,90,74,0.18)]',
          status === 'checking' && 'animate-pulse bg-foreground/25',
        )}
      />
    </span>
  )
}

/**
 * Resolves the actor's runtime for the avatar icon. `default_agent_type` is
 * only set once a user explicitly picks one in Settings — most actors only
 * ever populate `agent_types` (what the daemon actually advertises), so that
 * array is the primary signal and `default_agent_type` is just a tie-breaker.
 */
function resolveActorAgentType(actor: Pick<ActorRow, 'default_agent_type' | 'agent_types'>) {
  return (
    amuxAgentTypeFromBackend(actor.default_agent_type) ??
    actor.agent_types?.map((t) => amuxAgentTypeFromBackend(t)).find((t): t is NonNullable<typeof t> => !!t) ??
    null
  )
}

/**
 * Distinguishes the local agent's runtime at a glance in the sidebar avatar —
 * each backend gets its own mark instead of a generic bot icon.
 */
function AgentTypeIcon({ agentType }: { agentType?: string | null }) {
  const className = 'h-4 w-4'
  switch (agentType) {
    case 'claude-code':
      return <ClaudeMark className={className} />
    case 'opencode':
      return <OpencodeMark className={className} />
    case 'cursor':
      return <CursorMark className={className} />
    case 'pi':
      return <PiAgentMark className={className} />
    default:
      return <Bot className={className} strokeWidth={2} />
  }
}

/**
 * Status copy for the local daemon online / offline / MQTT indicators.
 */
function localDaemonStatusLabel(
  status: LocalDaemonRuntimeStatus,
  t: (key: string, fallback: string) => string,
): string {
  switch (status) {
    case 'online':
      return t('sidebar.localDaemonOnline', 'Online')
    case 'offline':
      return t('sidebar.localDaemonOffline', 'Offline')
    case 'daemonMqttDisconnected':
      return t('sidebar.localDaemonMqttDisconnected', 'Agent real-time channel disconnected')
    default:
      return t('sidebar.localDaemonChecking', 'Checking…')
  }
}

function SheetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 pl-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

function SheetMenuItem({
  icon,
  children,
  destructive,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  destructive?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[12.5px] transition-colors',
        destructive
          ? 'text-destructive hover:bg-destructive/8'
          : 'text-ink-2 hover:bg-selected hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <span className="flex w-4 shrink-0 items-center justify-center opacity-70">{icon}</span>
      {children}
    </button>
  )
}

function SheetHeader({
  displayName,
  actorId,
  agentType,
  workspaceLabel,
  workspaceTitle,
  workspaceUnset,
  runtimeStatus,
  statusLabel,
  expanded,
  onHandleClick,
  onAvatarClick,
}: {
  displayName: string
  actorId: string
  agentType?: string | null
  workspaceLabel: string
  workspaceTitle?: string
  workspaceUnset: boolean
  runtimeStatus: LocalDaemonRuntimeStatus
  statusLabel: string
  expanded: boolean
  onHandleClick: () => void
  onAvatarClick: () => void
}) {
  const { t } = useTranslation()
  const headTitle = `${displayName} · ${shortenActorId(actorId)}`

  return (
    <div>
      <div
        className={cn(
          'overflow-hidden transition-[max-height,opacity,margin-bottom] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          expanded
            ? 'mb-2.5 max-h-10 opacity-100'
            : 'mb-0 max-h-0 opacity-0 group-hover/local-daemon:mb-2.5 group-hover/local-daemon:max-h-10 group-hover/local-daemon:opacity-100',
        )}
      >
        <button
          type="button"
          onClick={onHandleClick}
          className="mx-auto flex w-full max-w-[3.5rem] cursor-pointer items-center justify-center rounded-md py-1.5 hover:bg-selected/50"
          aria-expanded={expanded}
          aria-label={expanded
            ? t('sidebar.localDaemonCollapseSheet', 'Collapse menu')
            : t('sidebar.localDaemonExpandSheet', 'Expand menu')}
        >
          <span className="block h-0.5 w-7 rounded-full bg-border" aria-hidden />
        </button>
      </div>
      <div
        className={cn(
          'transition-[margin] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          expanded && 'mb-2.5',
        )}
      >
        <div className="flex items-center gap-2.5" title={headTitle}>
          <button
            type="button"
            onClick={onAvatarClick}
            className={cn(
              'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-center rounded-md transition-colors hover:brightness-[1.04]',
              runtimeStatus === 'offline'
                ? 'bg-foreground/10 text-muted-foreground hover:bg-foreground/15'
                : runtimeStatus === 'daemonMqttDisconnected'
                  ? 'bg-amber-400/15 text-amber-800 hover:bg-amber-400/25'
                  : 'bg-coral text-white hover:brightness-[1.06]',
            )}
            aria-label={t('actors.contextMenu.viewProfile', 'View profile')}
          >
            <AgentTypeIcon agentType={agentType} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="truncate text-[12.5px] font-semibold leading-tight">{displayName}</div>
              <RuntimeStatusDot status={runtimeStatus} label={statusLabel} />
            </div>
            <div
              className={cn(
                'mt-0.5 truncate text-[11px] leading-snug',
                workspaceUnset ? 'text-faint' : 'text-muted-foreground',
              )}
              title={workspaceUnset ? undefined : workspaceTitle}
            >
              {workspaceLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SheetGroupWithAction({
  label,
  action,
  children,
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center justify-between gap-2 pl-0.5 pr-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-faint">
          {label}
        </span>
        {action}
      </div>
      {children}
    </div>
  )
}

function WorkspaceRow({
  ws,
  active,
  isCurrent,
  isDefault,
  onSelect,
  onSwitch,
  onDelete,
  switchLabel,
  deleteLabel,
  currentLabel,
  defaultLabel,
}: {
  ws: DaemonWorkspace
  active: boolean
  isCurrent: boolean
  isDefault: boolean
  onSelect: () => void
  onSwitch: () => void
  onDelete: () => void
  switchLabel: string
  deleteLabel: string
  currentLabel: string
  defaultLabel: string
}) {
  return (
    <div
      className={cn(
        'group/ws-row flex items-center gap-1 rounded-lg pr-1 transition-colors',
        active ? 'bg-selected' : 'hover:bg-selected/60',
      )}
    >
      <span
        className={cn(
          'ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
          isCurrent ? 'bg-emerald-500' : 'bg-transparent',
        )}
        title={isCurrent ? currentLabel : undefined}
        aria-label={isCurrent ? currentLabel : undefined}
        aria-hidden={!isCurrent}
      />
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-[6px] pl-1.5 pr-2.5 text-left text-[12.5px] transition-colors',
          active ? 'font-semibold text-foreground' : 'text-ink-2',
        )}
        title={ws.path ?? ws.name}
      >
        <span className="min-w-0 flex-1 truncate">{ws.name}</span>
        {isDefault ? (
          <Star
            className="h-3 w-3 shrink-0 fill-coral text-coral"
            aria-label={defaultLabel}
          />
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-0.5 self-center opacity-40 transition-opacity group-hover/ws-row:opacity-100 group-focus-within/ws-row:opacity-100">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onSwitch()
          }}
          disabled={!ws.path || isCurrent}
          className="cursor-pointer rounded-md p-1 text-faint hover:bg-selected hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          title={switchLabel}
          aria-label={switchLabel}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="cursor-pointer rounded-md p-1 text-faint hover:bg-destructive/10 hover:text-destructive"
          title={deleteLabel}
          aria-label={deleteLabel}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

/**
 * Local daemon agent pinned in the sidebar footer: sheet header (always visible)
 * + expandable action menu (scheme E). Workspace list is inline in the sheet.
 */
export function LocalDaemonRow({
  actor,
  runtimeStatus,
  isDefault = false,
  onViewDetail,
}: Props) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)

  const sheetOpen = useUIStore((s) => s.localDaemonSheetOpen)
  const toggleSheet = useUIStore((s) => s.toggleLocalDaemonSheet)
  const setSheetOpen = useUIStore((s) => s.setLocalDaemonSheetOpen)

  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const openSettings = useUIStore((s) => s.openSettings)
  const openAutomationPanel = useUIStore((s) => s.openAutomationPanel)
  const setDefaultAgent = useMemberPreferencesStore((s) => s.setDefaultAgent)

  const currentWorkspacePath = useWorkspaceStore((s) => s.workspacePath)
  const currentWorkspaceName = useWorkspaceStore((s) => s.workspaceName)
  const refreshDaemon = useDaemonOnboardingStore((s) => s.refresh)
  const checkCloudSession = useDaemonOnboardingStore((s) => s.checkCloudSession)
  const daemonBusy = useDaemonOnboardingStore((s) => s.busy)
  const workspaceSyncEpoch = useDaemonOnboardingStore((s) => s.workspaceSyncEpoch)

  const daemonOffline = runtimeStatus === 'offline'
  const daemonMqttDisconnected = runtimeStatus === 'daemonMqttDisconnected'
  const statusLabel = localDaemonStatusLabel(runtimeStatus, t)

  const agentId = actor?.id ?? null
  const defaultWorkspaceId = actor?.default_workspace_id ?? null
  const [workspaces, setWorkspaces] = React.useState<DaemonWorkspace[]>([])
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [retrying, setRetrying] = React.useState(false)
  const workspacesRef = React.useRef(workspaces)
  workspacesRef.current = workspaces
  const loadGenerationRef = React.useRef(0)

  // Prefetch as soon as the card mounts — don't wait for sheet expand. Opening
  // the sheet mid-fetch used to mutate content height during the 300ms
  // grid-rows animation and felt like dropped frames.
  const loadWorkspaces = React.useCallback(async (opts?: { forceLoading?: boolean }) => {
    if (!teamId || !agentId) return
    const generation = loadGenerationRef.current
    const showLoading = opts?.forceLoading ?? workspacesRef.current.length === 0
    if (showLoading) setLoading(true)
    try {
      const ws = await listDaemonWorkspaces(teamId, agentId)
      if (generation !== loadGenerationRef.current) return
      setWorkspaces(ws.filter((w) => !w.archived))
      void syncSessionWorkspaces(teamId).catch(() => {})
    } finally {
      if (showLoading && generation === loadGenerationRef.current) {
        setLoading(false)
      }
    }
  }, [teamId, agentId])

  React.useEffect(() => {
    if (daemonOffline) return
    if (!teamId || !agentId) {
      setWorkspaces([])
      return
    }
    loadGenerationRef.current += 1
    setWorkspaces([])
    void loadWorkspaces({ forceLoading: true })
  }, [daemonOffline, teamId, agentId, loadWorkspaces, workspaceSyncEpoch])

  const handleNewWorkspace = async () => {
    if (!teamId || !agentId || creating || daemonOffline) return
    let selected: string | string[] | null
    try {
      selected = await open({ directory: true, multiple: false, title: t('sidebar.newWorkspace', 'New workspace') })
    } catch (err) {
      console.error('[LocalDaemonRow] folder dialog failed', err)
      return
    }
    if (typeof selected !== 'string') return
    const path = selected
    setCreating(true)
    try {
      // createDaemonWorkspace is the sole writer for workspace path/UUID (POST
      // /v1/workspaces, deduped by (teamId, path) on the server) — no separate
      // daemon addWorkspace RPC round-trip is needed here.
      await createDaemonWorkspace({
        teamId,
        agentId,
        createdByMemberId: currentMember?.id ?? null,
        name: workspaceNameFromPath(path),
        path,
      })
      await useWorkspaceStore.getState().setWorkspace(path)
      await loadWorkspaces()
    } catch (err) {
      toast.error(t('sidebar.workspaceAddFailed', 'Failed to add workspace: {{msg}}', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setCreating(false)
    }
  }

  const handleSwitchWorkspace = async (ws: DaemonWorkspace) => {
    if (!ws.path) return
    try {
      await useWorkspaceStore.getState().setWorkspace(ws.path)
    } catch (err) {
      toast.error(t('sidebar.workspaceSwitchFailed', 'Failed to switch workspace: {{msg}}', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleDeleteWorkspace = async (ws: DaemonWorkspace) => {
    try {
      await updateDaemonWorkspace({ workspaceId: ws.id, name: ws.name, path: ws.path ?? '', archived: true })
      await loadWorkspaces()
    } catch (err) {
      toast.error(t('sidebar.workspaceDeleteFailed', 'Failed to delete workspace: {{msg}}', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleRetryConnection = async () => {
    if (retrying || daemonBusy) return
    setRetrying(true)
    // Kick the actual MQTT reconnect and a fresh status probe *first*, without
    // waiting on the cloud calls below. Right after an outage those calls can
    // sit in long timeouts; blocking the reconnect behind them is what made the
    // click feel dead. Fire-and-forget so recovery starts immediately.
    void recoverMqttConnection()
    requestDaemonProbe()
    try {
      await checkCloudSession({ allowRetryAfterHealError: true })
      await refreshDaemon()
      // Reflect the refreshed daemon/cloud state now instead of on the next
      // 20s poll tick.
      requestDaemonProbe()
      const { cloudAuthExpired, healError } = useDaemonOnboardingStore.getState()
      if (cloudAuthExpired && healError) {
        toast.error(healError)
        return
      }
    } catch (err) {
      console.error('[LocalDaemonRow] daemon refresh failed', err)
      toast.error(t('sidebar.localDaemonOfflineHint', 'Daemon offline — check Settings'))
    } finally {
      setRetrying(false)
    }
  }

  const handleToggleDefault = () => {
    if (!teamId || !actor) return
    void setDefaultAgent(teamId, isDefault ? null : actor.id).catch((e) => {
      console.error('[LocalDaemonRow] set default agent failed', e)
    })
  }

  // The daemon's MQTT link is down — not the app's own client, so
  // `recoverMqttConnection()` (which only restarts the app-side client) would do
  // nothing here. Re-probe, then send the user to Settings where the daemon can
  // be restarted.
  const handleDaemonMqttReconnect = () => {
    requestDaemonProbe()
    openSettings('general')
  }

  const handleOpenAutomation = () => {
    setSheetOpen(false)
    openAutomationPanel()
  }

  if (!actor) return null

  const workspaceLabel = currentWorkspaceName || t('workspace.selectWorkspace', 'Select Workspace')
  const workspaceUnset = !currentWorkspaceName

  const workspaceRows = (
    <div className="max-h-36 overflow-y-auto">
      {loading && workspaces.length === 0 ? (
        <div className="px-2.5 py-1.5 text-[12px] text-faint">{t('sidebar.workspacesLoading', 'Loading workspaces…')}</div>
      ) : null}
      {!loading && workspaces.length === 0 ? (
        <div className="px-2.5 py-1.5 text-[12px] text-faint">{t('sidebar.noWorkspaces', 'No workspaces yet')}</div>
      ) : null}
      {workspaces.map((ws) => {
        const active = filter.kind === 'workspace' && (filter.workspaceId === ws.id || filter.path === (ws.path ?? ''))
        const isCurrent = !!currentWorkspacePath && !!ws.path && workspacePathsMatch(ws.path, currentWorkspacePath)
        const wsIsDefault = !!defaultWorkspaceId && ws.id === defaultWorkspaceId
        return (
          <WorkspaceRow
            key={ws.id}
            ws={ws}
            active={active}
            isCurrent={isCurrent}
            isDefault={wsIsDefault}
            onSelect={() => setFilter({ kind: 'workspace', workspaceId: ws.id, path: ws.path ?? '', name: ws.name })}
            onSwitch={() => void handleSwitchWorkspace(ws)}
            onDelete={() => void handleDeleteWorkspace(ws)}
            switchLabel={t('sidebar.switchToWorkspace', 'Switch to this workspace')}
            deleteLabel={t('common.delete', 'Delete')}
            currentLabel={t('sidebar.currentWorkspace', 'Current workspace')}
            defaultLabel={t('sidebar.defaultWorkspace', 'Default workspace')}
          />
        )
      })}
    </div>
  )

  return (
    <div className="overflow-hidden">
      <div className={cn(sheetOpen ? 'px-0 pb-2 pt-1' : 'p-0')}>
        <SheetHeader
          displayName={actor.display_name}
          actorId={actor.id}
          agentType={resolveActorAgentType(actor)}
          workspaceLabel={workspaceLabel}
          workspaceTitle={currentWorkspacePath ?? undefined}
          workspaceUnset={workspaceUnset}
          runtimeStatus={runtimeStatus}
          statusLabel={statusLabel}
          onHandleClick={toggleSheet}
          onAvatarClick={() => onViewDetail(actor)}
          expanded={sheetOpen}
        />

        {daemonMqttDisconnected ? (
          <button
            type="button"
            onClick={handleDaemonMqttReconnect}
            className="mb-2 flex w-full cursor-pointer items-start rounded-lg border border-amber-400/45 bg-amber-400/10 px-2 py-1.5 text-left transition-colors hover:bg-amber-400/20"
          >
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[11.5px] font-semibold text-foreground">
                {t(
                  'sidebar.localDaemonMqttDisconnectedTitle',
                  'Agent real-time channel disconnected',
                )}
              </span>
              <span className="block truncate text-[10.5px] text-muted-foreground">
                {t(
                  'sidebar.localDaemonMqttDisconnectedHint',
                  'Local agent is up, but its MQTT link is down · Tap to open Settings',
                )}
              </span>
            </span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={handleOpenAutomation}
          className={cn(
            'mt-2 flex w-full cursor-pointer items-center gap-2 rounded-lg bg-background px-2.5 py-1.5 text-left transition-colors hover:bg-selected',
            sheetOpen && 'mb-2',
          )}
          aria-label={t('sidebar.localDaemonAutomationAria', 'Open automation settings')}
        >
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-2">
            {t('sidebar.localDaemonAutomation', 'Automation')}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        </button>

        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            sheetOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                'transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                sheetOpen
                  ? 'translate-y-0 opacity-100'
                  : 'pointer-events-none translate-y-2 opacity-0',
              )}
            >
              {daemonOffline ? (
                <SheetGroup label={t('sidebar.localDaemonGroupConnection', 'Connection')}>
                  <SheetMenuItem
                    icon={retrying || daemonBusy
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <RefreshCw className="h-3.5 w-3.5" />}
                    disabled={retrying || daemonBusy}
                    onClick={() => void handleRetryConnection()}
                  >
                    {retrying || daemonBusy
                      ? t('sidebar.localDaemonRetrying', 'Retrying…')
                      : t('chat.sessionAgent.retryConnection', 'Retry connection')}
                  </SheetMenuItem>
                  <SheetMenuItem
                    icon={<Settings className="h-3.5 w-3.5" />}
                    onClick={() => {
                      setSheetOpen(false)
                      openSettings('daemonGeneral')
                    }}
                  >
                    {t('sidebar.localDaemonDaemonSettings', 'Daemon settings')}
                  </SheetMenuItem>
                  <SheetMenuItem
                    icon={<LifeBuoy className="h-3.5 w-3.5" />}
                    onClick={() => {
                      setSheetOpen(false)
                      openSettings('diagnostics')
                    }}
                  >
                    {t('settings.diagnostics.openFromSidebar', 'Run diagnostics')}
                  </SheetMenuItem>
                </SheetGroup>
              ) : (
                <>
                  <SheetGroupWithAction
                    label={t('sidebar.localDaemonGroupWorkspace', 'Workspace')}
                    action={(
                      <button
                        type="button"
                        onClick={() => void handleNewWorkspace()}
                        disabled={creating}
                        className="cursor-pointer rounded-md p-0.5 text-faint hover:bg-selected hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title={t('sidebar.newWorkspace', 'New workspace')}
                        aria-label={t('sidebar.newWorkspace', 'New workspace')}
                      >
                        {creating
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Plus className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  >
                    {workspaceRows}
                  </SheetGroupWithAction>
                  <SheetGroup label={t('sidebar.localDaemonGroupDevice', 'Device')}>
                    <SheetMenuItem
                      icon={<Settings className="h-3.5 w-3.5" />}
                      onClick={() => {
                        setSheetOpen(false)
                        openSettings('daemonGeneral')
                      }}
                    >
                      {t('sidebar.localDaemonDaemonSettings', 'Daemon settings')}
                    </SheetMenuItem>
                  </SheetGroup>
                </>
              )}

              <SheetGroup label={t('sidebar.localDaemonGroupTeam', 'Team')}>
                <SheetMenuItem
                  icon={<Star className={cn('h-3.5 w-3.5', isDefault && 'fill-current')} />}
                  disabled={!teamId}
                  onClick={handleToggleDefault}
                >
                  {isDefault
                    ? t('actors.contextMenu.removeDefault', 'Remove as default agent')
                    : t('actors.contextMenu.setDefault', 'Set as default agent')}
                </SheetMenuItem>
              </SheetGroup>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
