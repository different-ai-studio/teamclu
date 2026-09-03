import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ChevronDown,
  Copy,
  FolderOpen,
  Loader2,
  MessageCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { actorAvatarColor } from '@/lib/actor/actor-color'
import { getAcpDebugLogDirectory, revealAcpDebugLog } from '@/lib/diagnostics/acp-debug-file-log'
import { formatDate, formatRelativeTime } from '@/lib/ui/date-format'
import {
  fetchSessionDetailSnapshot,
  type SessionDetailSnapshot,
  type SessionRuntimeDetail,
} from '@/lib/session/session-detail'
import type { SessionListActivity } from '@/lib/session/session-list-activity'
import { cn, isTauri } from '@/lib/utils'
import {
  isAcpDebugPanelVisible,
  useAcpDebugStore,
} from '@/stores/acp-debug-store'
import type { SessionParticipantInfo } from '@/stores/session-participant-store'
import { useRuntimeStateStore } from '@/stores/runtime-state-store'

export interface SessionDetailListHints {
  title?: string
  mode?: string | null
  ideaId?: string | null
  isPinned?: boolean
  lastMessageAt?: string | null
  lastMessagePreview?: string | null
}

interface Props {
  sessionId: string | null
  teamId: string | null
  hints?: SessionDetailListHints | null
  participants?: SessionParticipantInfo[]
  activity?: SessionListActivity
  activeSessionId?: string | null
  onOpenChange: (open: boolean) => void
  onOpenSession?: (sessionId: string) => void
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 truncate text-foreground', mono && 'font-mono text-[12px]')}>
        {value || '—'}
      </dd>
    </>
  )
}

function RuntimeCard({ runtime }: { runtime: SessionRuntimeDetail }) {
  const { t } = useTranslation()
  const c = actorAvatarColor(runtime.agentId)
  const model = runtime.liveModel ?? runtime.dbModel
  const stateLabel = runtime.liveState ?? runtime.dbStatus

  return (
    <div className="rounded-[14px] border border-border-soft bg-paper p-3">
      <div className="flex items-center gap-2">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white"
          style={{ background: c.bg, color: c.fg }}
        >
          {runtime.agentName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-foreground">{runtime.agentName}</div>
          <div className="truncate font-mono text-[11px] text-faint">{runtime.agentId}</div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12.5px] leading-5">
        <DetailField
          label={t('sessions.detail.runtimeId', 'Runtime ID')}
          value={runtime.runtimeId}
          mono
        />
        <DetailField label={t('sessions.detail.model', 'Model')} value={model} mono />
        <DetailField label={t('sessions.detail.state', 'State')} value={stateLabel} />
        <DetailField label={t('sessions.detail.backend', 'Backend')} value={runtime.backendType} />
        <DetailField
          label={t('sessions.detail.backendSessionId', 'Backend session')}
          value={runtime.backendSessionId}
          mono
        />
        <DetailField
          label={t('sessions.detail.workspace', 'Workspace')}
          value={runtime.workspacePath ?? runtime.workspaceId}
          mono
        />
        <DetailField
          label={t('sessions.detail.lastSeen', 'Last seen')}
          value={runtime.lastSeenAt ? formatRelativeTime(new Date(runtime.lastSeenAt)) : null}
        />
      </dl>
    </div>
  )
}

function activityLabel(
  activity: SessionListActivity | undefined,
  t: (key: string, fallback: string) => string,
) {
  if (!activity) return null
  if (activity.state === 'running') return t('sidebar.sessionRunning', 'Running')
  if (activity.kind === 'permission') return t('sidebar.awaitingConfirmation', 'Awaiting confirmation')
  if (activity.kind === 'question') return t('sessions.detail.awaitingQuestion', 'Awaiting answer')
  return t('sessions.detail.waiting', 'Waiting')
}

export function SessionDetailDialog({
  sessionId,
  teamId,
  hints,
  participants = [],
  activity,
  activeSessionId,
  onOpenChange,
  onOpenSession,
}: Props) {
  const { t } = useTranslation()
  const lastSessionIdRef = React.useRef<string | null>(null)
  if (sessionId) lastSessionIdRef.current = sessionId
  const displaySessionId = sessionId ?? lastSessionIdRef.current

  const liveByRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId)
  const acpLines = useAcpDebugStore((s) => s.lines)

  const [snapshot, setSnapshot] = React.useState<SessionDetailSnapshot | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [rawOpen, setRawOpen] = React.useState(isAcpDebugPanelVisible())
  const [devOpen, setDevOpen] = React.useState(isAcpDebugPanelVisible())
  const [logDir, setLogDir] = React.useState<string | null>(null)

  const open = !!sessionId

  React.useEffect(() => {
    if (!open || !displaySessionId || !teamId) return
    let cancelled = false
    setLoading(true)
    void fetchSessionDetailSnapshot({
      sessionId: displaySessionId,
      teamId,
      participants,
      liveByRuntimeId,
      hints: {
        title: hints?.title,
        mode: hints?.mode,
        ideaId: hints?.ideaId,
        lastMessageAt: hints?.lastMessageAt,
        lastMessagePreview: hints?.lastMessagePreview,
      },
    })
      .then((next) => {
        if (!cancelled) setSnapshot(next)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    displaySessionId,
    hints?.ideaId,
    hints?.lastMessageAt,
    hints?.lastMessagePreview,
    hints?.mode,
    hints?.title,
    liveByRuntimeId,
    open,
    participants,
    teamId,
  ])

  React.useEffect(() => {
    if (!open || !isTauri()) return
    void getAcpDebugLogDirectory().then(setLogDir)
  }, [open])

  if (!displaySessionId) return null

  const detail = snapshot
  const title = detail?.title || hints?.title || t('chat.newChat', 'New Chat')
  const mode = detail?.mode ?? hints?.mode
  const lastMessageAt = detail?.lastMessageAt ?? hints?.lastMessageAt
  const activityText = activityLabel(activity, t)
  const acpLineCount = acpLines.filter((line) => line.sessionId === displaySessionId).length
  const showOpenSession = activeSessionId !== displaySessionId

  const copyText = async (_label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const rawPayload = {
    session: detail,
    participants,
    activity: activity ?? null,
    acpDebugLineCount: acpLineCount,
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[86vh] w-[min(760px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden border-border bg-background p-0 shadow-xl"
        data-testid="session-detail-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('sessions.detail.title', 'Session details')}</DialogTitle>
          <DialogDescription>
            {t('sessions.detail.description', 'View session metadata and runtime state.')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-10">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-[18px] bg-panel text-coral ring-[1.5px] ring-coral/30">
              <MessageCircle className="h-8 w-8" />
            </div>
            <div className="mt-4 max-w-full truncate text-[22px] font-bold leading-tight text-foreground">
              {title}
            </div>
            <div className="mt-2 text-[14px] leading-5 text-muted-foreground">
              {[mode, lastMessageAt ? formatRelativeTime(new Date(lastMessageAt)) : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {(activityText || hints?.isPinned) && (
              <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2">
                {hints?.isPinned && (
                  <span className="rounded-full border border-border-soft bg-paper px-3 py-1 text-[12px] text-ink-2">
                    {t('sidebar.pinned', 'Pinned')}
                  </span>
                )}
                {activityText && (
                  <span className="rounded-full border border-border-soft bg-paper px-3 py-1 text-[12px] text-ink-2">
                    {activityText}
                  </span>
                )}
              </div>
            )}
          </div>

          {loading && !detail && (
            <div className="mt-8 flex justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {detail?.loadError && (
            <div className="mt-6 rounded-[10px] border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              {detail.loadError}
            </div>
          )}

          {detail && (
            <>
              <section className="mt-8 border-t border-border-soft pt-5">
                <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  {t('sessions.detail.overview', 'Overview')}
                </div>
                <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-5 gap-y-4 text-[13px] leading-5">
                  <DetailField label={t('sessions.detail.mode', 'Mode')} value={detail.mode} />
                  <DetailField
                    label={t('sessions.detail.created', 'Created')}
                    value={detail.createdAt ? formatDate(detail.createdAt) : null}
                  />
                  <DetailField
                    label={t('sessions.detail.updated', 'Updated')}
                    value={detail.updatedAt ? formatDate(detail.updatedAt) : null}
                  />
                  <DetailField
                    label={t('sessions.detail.lastMessage', 'Last message')}
                    value={detail.lastMessagePreview}
                  />
                  <DetailField
                    label={t('sessions.detail.primaryAgent', 'Primary agent')}
                    value={detail.primaryAgentId}
                    mono
                  />
                  <DetailField label={t('sessions.detail.idea', 'Idea')} value={detail.ideaId} mono />
                  <DetailField label={t('sessions.detail.summary', 'Summary')} value={detail.summary} />
                </dl>
              </section>

              <section className="mt-8 border-t border-border-soft pt-5">
                <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  {t('sessions.detail.identifiers', 'Identifiers')}
                </div>
                <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-5 gap-y-4 text-[13px] leading-5">
                  <DetailField
                    label={t('sessions.detail.sessionId', 'Session ID')}
                    value={detail.sessionId}
                    mono
                  />
                  <DetailField label={t('sessions.detail.teamId', 'Team ID')} value={detail.teamId} mono />
                  <DetailField
                    label={t('sessions.detail.acpSessionId', 'ACP session ID')}
                    value={detail.acpSessionId}
                    mono
                  />
                  <DetailField label={t('sessions.detail.binding', 'Binding')} value={detail.binding} mono />
                </dl>
              </section>

              {participants.length > 0 && (
                <section className="mt-8 border-t border-border-soft pt-5">
                  <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                    {t('sessions.detail.participants', 'Participants')} · {participants.length}
                  </div>
                  <div className="space-y-2">
                    {participants.map((participant) => {
                      const c = actorAvatarColor(participant.actorId)
                      return (
                        <div
                          key={participant.actorId}
                          className="flex items-center gap-3 rounded-[10px] border border-border-soft bg-paper px-3 py-2"
                        >
                          <Avatar
                            className={cn(
                              'h-8 w-8',
                              participant.isAgent ? 'rounded-[6px]' : 'rounded-full',
                            )}
                          >
                            {participant.avatarUrl && (
                              <AvatarImage src={participant.avatarUrl} alt={participant.displayName} />
                            )}
                            <AvatarFallback
                              className={cn(
                                'text-[11px] font-semibold',
                                participant.isAgent ? 'rounded-[6px]' : 'rounded-full',
                              )}
                              style={{ background: c.bg, color: c.fg }}
                            >
                              {participant.displayName.slice(0, 1).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-foreground">
                              {participant.displayName}
                            </div>
                            <div className="truncate font-mono text-[11px] text-faint">
                              {participant.actorId}
                            </div>
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {participant.isAgent
                              ? t('actors.detail.agent', 'Agent')
                              : t('actors.detail.member', 'Member')}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}

              <section className="mt-8 border-t border-border-soft pt-5">
                <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  {t('sessions.detail.runtime', 'Runtime')}
                </div>
                {detail.runtimes.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">
                    {t('sessions.detail.noRuntime', 'No runtime bound to this session yet.')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {detail.runtimes.map((runtime) => (
                      <RuntimeCard key={runtime.agentId} runtime={runtime} />
                    ))}
                  </div>
                )}
                {detail.workspaces.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {detail.workspaces.map((workspace) => (
                      <div
                        key={`${workspace.sessionId}:${workspace.agentId}:${workspace.workspaceId ?? workspace.workspacePath ?? 'default'}`}
                        className="rounded-[10px] border border-border-soft bg-panel/60 px-3 py-2 font-mono text-[12px] text-ink-2"
                      >
                        {workspace.workspacePath ?? workspace.workspaceId ?? '—'}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="mt-8 border-t border-border-soft pt-5">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint"
                  onClick={() => setRawOpen((value) => !value)}
                >
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', rawOpen && 'rotate-180')} />
                  {t('sessions.detail.rawJson', 'Raw JSON')}
                </button>
                {rawOpen && (
                  <pre className="mt-3 max-h-56 overflow-auto rounded-[10px] border border-border-soft bg-panel/60 p-3 font-mono text-[11px] leading-5 text-ink-2">
                    {JSON.stringify(rawPayload, null, 2)}
                  </pre>
                )}
              </section>

              {isAcpDebugPanelVisible() && (
                <section className="mt-8 border-t border-border-soft pt-5">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint"
                    onClick={() => setDevOpen((value) => !value)}
                  >
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', devOpen && 'rotate-180')} />
                    {t('sessions.detail.developer', 'Developer')}
                  </button>
                  {devOpen && (
                    <div className="mt-3 space-y-2 text-[12.5px] text-ink-2">
                      <div>
                        {t('sessions.detail.acpLines', '{{count}} ACP debug lines', { count: acpLineCount })}
                      </div>
                      {logDir && (
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {t('sessions.detail.acpLogHint', '{{dir}}/{{sessionId}}.log', {
                            dir: logDir,
                            sessionId: displaySessionId.slice(0, 8),
                          })}
                        </div>
                      )}
                      {isTauri() && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 rounded-[8px] text-[12px]"
                          onClick={() => void revealAcpDebugLog(displaySessionId)}
                        >
                          <FolderOpen className="mr-2 h-3.5 w-3.5" />
                          {t('sessions.detail.revealAcpLog', 'Reveal ACP log')}
                        </Button>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-3 border-t border-border-soft bg-paper px-6 py-4 sm:justify-between">
          {showOpenSession ? (
            <Button
              onClick={() => {
                onOpenSession?.(displaySessionId)
                onOpenChange(false)
              }}
              className="h-10 flex-1 rounded-[9px] bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              <MessageCircle className="mr-2 h-4 w-4" />
              {t('sessions.detail.openSession', 'Open session')}
            </Button>
          ) : (
            <div className="flex-1" />
          )}
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-[9px] text-[13px]"
            onClick={() => void copyText(t('sessions.detail.sessionId', 'Session ID'), displaySessionId)}
          >
            <Copy className="mr-2 h-4 w-4" />
            {t('sessions.detail.copySessionId', 'Copy session ID')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
