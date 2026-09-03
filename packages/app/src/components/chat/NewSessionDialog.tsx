import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Pencil, Search, X } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { computeInitialSelection } from './new-session-prefill'

type Candidate = {
  id: string
  actor_type: 'member' | 'agent'
  display_name: string
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

  React.useEffect(() => {
    if (open) setMessage(initialMessage ?? '')
  }, [open, initialMessage])

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

  const canSubmit = message.trim().length > 0 && !submitting

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
              onToggle={() => togglePick(c.id)}
            />
          ))}
        </div>

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
  onToggle,
}: {
  candidate: Candidate
  checked: boolean
  onToggle: () => void
}) {
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
