import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Loader2, Pencil, Search, Star, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { resolveCurrentMemberActorId } from '@/lib/actor/current-actor'
import { syncActorsForTeam } from '@/lib/sync/actor-sync'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { actorAvatarColor } from '@/lib/actor/actor-color'
import { createSessionWithFirstMessage } from '@/lib/session/session-create'
import { promoteCreatedSessionToUi } from '@/lib/session/promote-created-session'
import { useEngagedAgentStore } from '@/stores/engaged-agent-store'
import { cn, isTauri } from '@/lib/utils'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { rememberDefaultWorkspaceId } from '@/stores/agent-default-workspace-store'
import {
  createDaemonWorkspace,
  listDaemonWorkspaces,
  setAgentDefaultWorkspace,
  type DaemonWorkspace,
} from '@/lib/daemon/daemon-workspaces'
import { shortenWorkspacePath } from '@/lib/workspace/shorten-path'
import { computeInitialSelection } from './new-session-prefill'

type Candidate = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
}

function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

export function NewSessionDialog() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.newSessionDialogOpen)
  const initialMessage = useUIStore((s) => s.newSessionDialogInitialMessage)
  const closeDialog = useUIStore((s) => s.closeNewSessionDialog)

  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const currentMemberId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)

  // Candidates come from the shared reactive actor directory store (same source
  // as the second column + RECENTS), so the picker is never stale and reuses the
  // store's cache-first + network reconcile instead of its own bespoke loader.
  const { actors, loading, error: loadError, refetch } = useActorDirectory()
  const effectiveDefaultAgentId = useMemberPreferencesStore((s) => s.effectiveDefaultAgentId)
  const effectiveDefaultTeamId = useMemberPreferencesStore((s) => s.effectiveDefaultTeamId)
  const effectiveDefaultLoading = useMemberPreferencesStore((s) => s.effectiveDefaultLoading)
  const prefillAppliedRef = React.useRef(false)

  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  // The agent running on THIS machine. Resolved from the local daemon's own
  // `/v1/info`, not from the directory — several agents in a team can share a
  // display name (three rows reading `liziliudeMacBook-Air` is the normal
  // case), so the badge and the workspace picker cannot be driven by name.
  const [localAgentId, setLocalAgentId] = React.useState<string | null>(null)
  const [workspaces, setWorkspaces] = React.useState<DaemonWorkspace[]>([])
  const [workspacesLoading, setWorkspacesLoading] = React.useState(false)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState<string>('')
  const [workspaceBusy, setWorkspaceBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) setMessage(initialMessage ?? '')
  }, [open, initialMessage])

  React.useEffect(() => {
    if (!open || !isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
        const id = await getLocalDaemonActorId()
        if (!cancelled) setLocalAgentId(id?.trim() || null)
      } catch {
        if (!cancelled) setLocalAgentId(null)
      }
    })()
    return () => { cancelled = true }
  }, [open])

  // On open: reset the picker, pull a fresh reconcile, kick a full background
  // sync, and trigger a load of the effective default agent.
  React.useEffect(() => {
    if (!open) {
      prefillAppliedRef.current = false
      return
    }
    setPicked(new Set())
    setQuery('')
    prefillAppliedRef.current = false
    if (!teamId) return
    refetch()
    void syncActorsForTeam(teamId, { full: true }).catch((e) =>
      console.warn('[NewSessionDialog] full sync failed (non-fatal):', e),
    )
    void useMemberPreferencesStore.getState().loadEffectiveDefaultAgent(teamId)
  }, [open, teamId, refetch])

  const candidates = React.useMemo<Candidate[]>(
    () =>
      actors
        .filter((a) => a.id !== currentMemberId)
        // External gateway contacts are in the same directory but cannot be put
        // in a session from here (no membership, nothing to route to), so they
        // are filtered out — as a predicate, which also narrows the kind.
        .filter((a): a is typeof a & { actor_type: 'member' | 'agent' } =>
          a.actor_type === 'member' || a.actor_type === 'agent')
        .map((a) => ({ id: a.id, actor_type: a.actor_type, display_name: a.display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [actors, currentMemberId],
  )

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((c) => c.display_name.toLowerCase().includes(q))
  }, [candidates, query])

  const pickedActors = React.useMemo(
    () => candidates.filter((c) => picked.has(c.id)),
    [candidates, picked],
  )

  // A workspace is a folder on one machine, so the picker only means anything
  // when the agent that would run there is in the session. Deselect it and the
  // choice is dropped rather than left dangling on an absent agent.
  const localAgentPicked = !!localAgentId && picked.has(localAgentId)

  const localAgentDefaultWorkspaceId = React.useMemo(() => {
    if (!localAgentId) return ''
    const row = actors.find((a) => a.id === localAgentId)
    return row?.default_workspace_id?.trim() ?? ''
  }, [actors, localAgentId])

  const loadWorkspaces = React.useCallback(async () => {
    if (!teamId || !localAgentId) return
    setWorkspacesLoading(true)
    try {
      const rows = await listDaemonWorkspaces(teamId, localAgentId)
      setWorkspaces(rows.filter((w) => !w.archived && !!w.path))
    } catch (e) {
      console.warn('[NewSessionDialog] workspace load failed (non-fatal):', e)
      setWorkspaces([])
    } finally {
      setWorkspacesLoading(false)
    }
  }, [teamId, localAgentId])

  React.useEffect(() => {
    if (!open || !localAgentPicked) {
      setWorkspaces([])
      setSelectedWorkspaceId('')
      return
    }
    void loadWorkspaces()
  }, [open, localAgentPicked, loadWorkspaces])

  // Land on the agent's own default; fall back to its first folder so the
  // picker is never empty-but-populated.
  React.useEffect(() => {
    if (!localAgentPicked || workspaces.length === 0) return
    setSelectedWorkspaceId((current) => {
      if (current && workspaces.some((w) => w.id === current)) return current
      const preferred = workspaces.find((w) => w.id === localAgentDefaultWorkspaceId)
      return (preferred ?? workspaces[0]).id
    })
  }, [localAgentPicked, workspaces, localAgentDefaultWorkspaceId])

  const selectedWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId],
  )

  const handleBrowseWorkspace = async () => {
    if (!teamId || !localAgentId) return
    setWorkspaceBusy(true)
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('chat.newSessionDialog.workspaceBrowse', '选择工作目录'),
      })
      const path = typeof selected === 'string' ? selected.trim() : ''
      if (!path) return
      const created = await createDaemonWorkspace({
        teamId,
        agentId: localAgentId,
        createdByMemberId: currentMemberId,
        name: workspaceNameFromPath(path),
        path,
      })
      await loadWorkspaces()
      setSelectedWorkspaceId(created.id)
    } catch (e) {
      const { toast } = await import('sonner')
      toast.error(
        t('chat.newSessionDialog.workspaceAddFailed', '添加工作目录失败：{{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const handleSetDefaultWorkspace = async () => {
    if (!localAgentId || !selectedWorkspace) return
    setWorkspaceBusy(true)
    try {
      await setAgentDefaultWorkspace(localAgentId, selectedWorkspace.id)
      // Keep the send-path fast cache in step with what we just wrote; a stale
      // entry here is what makes the next first message cold-start twice.
      rememberDefaultWorkspaceId([localAgentId], selectedWorkspace.id)
      refetch()
      const { toast } = await import('sonner')
      toast.success(t('chat.newSessionDialog.workspaceDefaultSet', '已设为默认工作目录'))
    } catch (e) {
      const { toast } = await import('sonner')
      toast.error(
        t('chat.newSessionDialog.workspaceDefaultFailed', '设置默认工作目录失败：{{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setWorkspaceBusy(false)
    }
  }

  // One-shot prefill: once per open, apply effective default agent selection.
  // Waits until the effective default has finished loading for this team before
  // applying, so we don't prematurely lock in an empty selection.
  React.useEffect(() => {
    if (!open) return
    if (prefillAppliedRef.current) return
    // Wait until the load for the current team has completed.
    if (effectiveDefaultLoading || effectiveDefaultTeamId !== teamId) return
    prefillAppliedRef.current = true
    const candidateIds = new Set(candidates.map((c) => c.id))
    setPicked(computeInitialSelection(effectiveDefaultAgentId, candidateIds))
  }, [open, effectiveDefaultAgentId, effectiveDefaultTeamId, effectiveDefaultLoading, candidates, teamId])

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const clearPicks = () => setPicked(new Set())

  const canSubmit = message.trim().length > 0 && !submitting && !!teamId

  const handleClose = () => {
    if (submitting) return
    closeDialog()
  }

  const handleCreate = async () => {
    if (!canSubmit || !teamId) return
    const authSession = useAuthStore.getState().session
    if (!authSession?.user?.id) return
    setSubmitting(true)
    try {
      const creatorActorId = await resolveCurrentMemberActorId(
        teamId,
        authSession.user.id,
        {
          currentTeamId: teamId,
          currentMemberId,
        },
      )
      if (!creatorActorId) {
        const { toast } = await import('sonner')
        toast.error(t('chat.newSessionDialog.noActorError', 'No member identity found for this team'))
        return
      }
      const additionalActorIds = Array.from(picked)
      const agentActorIds = pickedActors.filter((p) => p.actor_type === 'agent').map((p) => p.id)
      const trimmed = message.trim()
      const { sessionId } = await createSessionWithFirstMessage({
        teamId,
        creatorActorId,
        additionalActorIds,
        agentActorIds,
        messageText: trimmed,
        localWorkspace:
          localAgentPicked && selectedWorkspace?.path
            ? { workspaceId: selectedWorkspace.id, path: selectedWorkspace.path }
            : null,
      })
      const agentPicks = pickedActors.filter((p) => p.actor_type === 'agent')
      if (agentPicks.length > 0) {
        useEngagedAgentStore.getState().setAgents(
          sessionId,
          agentPicks.map((p) => ({
            id: p.id,
            displayName: p.display_name || 'AI',
          })),
        )
      }
      await promoteCreatedSessionToUi({
        sessionId,
        teamId,
        title: trimmed.split('\n')[0]?.trim().slice(0, 80) || 'New chat',
        lastMessagePreview: trimmed.slice(0, 120) || null,
      })
      closeDialog()
    } catch (e) {
      console.error('[NewSessionDialog] create failed:', e)
      const { toast } = await import('sonner')
      toast.error(t('chat.newSessionDialog.createError', 'Failed to create session'))
    } finally {
      setSubmitting(false)
    }
  }

  // ⌘↵ submits.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleCreate()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent
        className="sm:max-w-[560px] p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-coral-soft text-coral">
            <Pencil className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[16px] font-semibold leading-tight">
              {t('chat.newSessionDialog.title', '新会话')}
              <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                {t('chat.newSessionDialog.subtitle', '从一条消息开始')}
              </span>
            </DialogTitle>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/*
          No team, no session: the participant list, the creator actor and the
          session row all hang off a team id. The advanced button stays live in
          this state on purpose — it is the escape hatch when quick chat is
          dead — so it has to land somewhere that says what is missing.
        */}
        {!teamId ? (
          <div
            data-testid="new-session-no-team"
            className="border-t border-border px-5 py-10 text-center"
          >
            <div className="text-[13px] font-medium text-foreground">
              {t('chat.newSessionDialog.noTeamTitle', '还没有团队')}
            </div>
            <div className="pt-1.5 text-[12.5px] text-muted-foreground">
              {t(
                'chat.newSessionDialog.noTeamHint',
                '先创建或加入一个团队，才能发起会话。',
              )}
            </div>
          </div>
        ) : (
        <>
        {/* Participants chips */}
        <div className="px-5 pt-2 pb-3">
          <div className="flex items-center justify-between pb-2">
            <div className="text-[12px] text-muted-foreground">
              {t('chat.newSessionDialog.participants', '参与者')}
              <span className="mx-1.5 text-faint">·</span>
              <span className="font-mono tabular-nums">{pickedActors.length}</span>
            </div>
            {pickedActors.length > 0 && (
              <button
                type="button"
                onClick={clearPicks}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                {t('chat.newSessionDialog.clear', '清空')}
              </button>
            )}
          </div>
          {pickedActors.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2">
              {pickedActors.map((p) => (
                <ParticipantChip key={p.id} actor={p} onRemove={() => togglePick(p.id)} />
              ))}
            </div>
          )}
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('chat.newSessionDialog.searchPlaceholder', '搜索成员或 Agent…')}
              className="h-9 w-full rounded-lg border border-border bg-muted/30 pl-9 pr-3 text-[13px] outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
          </div>
        </div>

        {/* Candidate list */}
        <div className="max-h-[260px] min-h-[120px] overflow-y-auto border-y border-border bg-paper">
          {loading && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('chat.newSessionDialog.loading', '加载中…')}
            </div>
          )}
          {loadError && (
            <div className="px-5 py-4 text-sm text-destructive">
              {t('chat.newSessionDialog.loadError', '加载失败')}
            </div>
          )}
          {!loading && !loadError && filtered.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {candidates.length === 0
                ? t('chat.newSessionDialog.empty', '暂无成员或 Agent')
                : t('chat.newSessionDialog.noMatch', '没有匹配的结果')}
            </div>
          )}
          {!loading && !loadError && filtered.map((c) => (
            <CandidateRow
              key={c.id}
              candidate={c}
              checked={picked.has(c.id)}
              isLocal={c.id === localAgentId}
              onToggle={() => togglePick(c.id)}
            />
          ))}
        </div>

        {/* Workspace — only once the agent on this machine is in the session */}
        {localAgentPicked && (
          <div
            data-testid="new-session-workspace"
            className="border-b border-border px-5 pt-4 pb-3"
          >
            <div className="flex items-baseline justify-between pb-2">
              <label className="text-[12px] text-muted-foreground">
                {t('chat.newSessionDialog.workspaceLabel', '工作目录')}
              </label>
              <span className="text-[11.5px] text-faint">
                {t('chat.newSessionDialog.workspaceScope', '仅对本机 Agent 生效')}
              </span>
            </div>
            {workspacesLoading ? (
              <div className="flex items-center gap-2 py-1.5 text-[12.5px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('chat.newSessionDialog.loading', '加载中…')}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={selectedWorkspaceId}
                  onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                  disabled={workspaceBusy || workspaces.length === 0}
                  aria-label={t('chat.newSessionDialog.workspaceLabel', '工作目录')}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-muted/30 px-2.5 text-[13px] outline-none focus:border-foreground/30 disabled:opacity-50"
                >
                  {workspaces.length === 0 && (
                    <option value="">
                      {t('chat.newSessionDialog.workspaceNone', '本机还没有工作目录')}
                    </option>
                  )}
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.id === localAgentDefaultWorkspaceId
                        ? `${w.name} · ${t('chat.newSessionDialog.workspaceDefaultTag', '默认')}`
                        : w.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 gap-1.5"
                  disabled={workspaceBusy}
                  onClick={() => void handleBrowseWorkspace()}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('chat.newSessionDialog.workspaceBrowseAction', '浏览…')}
                </Button>
              </div>
            )}
            {selectedWorkspace?.path && (
              <div
                className="truncate pt-1.5 text-[11.5px] text-faint"
                title={selectedWorkspace.path}
              >
                {shortenWorkspacePath(selectedWorkspace.path)}
              </div>
            )}
            {selectedWorkspace && selectedWorkspace.id !== localAgentDefaultWorkspaceId && (
              <button
                type="button"
                disabled={workspaceBusy}
                onClick={() => void handleSetDefaultWorkspace()}
                className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                title={t(
                  'chat.newSessionDialog.workspaceDefaultWarning',
                  '将改变该 Agent 今后所有会话与定时任务的默认目录',
                )}
              >
                <Star className="h-3 w-3" />
                {t('chat.newSessionDialog.workspaceSetDefault', '设为默认')}
              </button>
            )}
          </div>
        )}

        {/* Opening message */}
        <div className="px-5 pt-4 pb-3">
          <label className="block pb-2 text-[12px] text-muted-foreground">
            {t('chat.newSessionDialog.openingMessage', '开场消息')}
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(
              'chat.newSessionDialog.messagePlaceholder',
              '想聊点什么？',
            )}
            rows={4}
            className="w-full resize-none rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-[13px] leading-[1.5] outline-none placeholder:text-muted-foreground focus:border-foreground/30"
          />
        </div>
        </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            disabled={submitting}
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!canSubmit}
            className="gap-2"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('chat.newSessionDialog.create', '创建会话')}
            <span className="rounded-md bg-black/15 px-1.5 py-px font-mono text-[10.5px] tracking-tight text-white/90">
              ⌘↵
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ParticipantChip({
  actor,
  onRemove,
}: {
  actor: Candidate
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const isAgent = actor.actor_type === 'agent'
  const c = actorAvatarColor(actor.id)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-paper py-0.5 pl-0.5 pr-1.5 text-[12px]',
      )}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center text-[10px] font-semibold',
          isAgent ? 'rounded' : 'rounded-full',
        )}
        style={{ background: c.bg, color: c.fg }}
      >
        {actor.display_name.slice(0, 1).toUpperCase()}
      </span>
      <span className="truncate font-medium">{actor.display_name}</span>
      {isAgent && (
        <span className="font-mono text-[9px] font-semibold tracking-wider text-coral">
          AI
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t('chat.newSessionDialog.removeParticipantAria', 'Remove participant')}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

function CandidateRow({
  candidate,
  checked,
  isLocal,
  onToggle,
}: {
  candidate: Candidate
  checked: boolean
  /** The agent running on this machine — the only one the workspace picker applies to. */
  isLocal: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const isAgent = candidate.actor_type === 'agent'
  const c = actorAvatarColor(candidate.id)
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors',
        checked ? 'bg-coral-soft/40' : 'hover:bg-muted/40',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center text-[12px] font-semibold',
          isAgent ? 'rounded-md' : 'rounded-full',
        )}
        style={{ background: c.bg, color: c.fg }}
      >
        {candidate.display_name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground">
            {candidate.display_name}
          </span>
          {isAgent && (
            <span className="shrink-0 rounded border border-coral/40 bg-coral/10 px-1 py-px font-mono text-[9px] font-semibold tracking-wider text-coral">
              AI
            </span>
          )}
          {/* Several agents in a team commonly share a display name, so this
              badge is the only way to tell which row is the machine you are on. */}
          {isLocal && (
            <span
              data-testid="candidate-local-badge"
              className="shrink-0 rounded border border-border bg-muted px-1 py-px text-[9.5px] font-semibold tracking-wide text-muted-foreground"
            >
              {t('chat.newSessionDialog.localAgentBadge', '本机')}
            </span>
          )}
        </div>
      </div>
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          checked
            ? 'border-coral bg-coral text-coral-foreground'
            : 'border-border bg-paper',
        )}
        aria-hidden
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
            <path d="M2.5 6.5L4.8 8.8L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </button>
  )
}
