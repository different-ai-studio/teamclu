import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Link2, Loader2, MessageCircle, Sparkles, User as UserIcon, UserMinus, X } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getBackend } from '@/lib/backend'
import { buildInviteDeeplink } from '@/lib/invite-deeplink'
import { formatActorRemoveError } from '@/lib/actor-remove-error'
import type { ClientVersionEntry } from '@/lib/backend/types'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatDate, formatRelativeTime } from '@/lib/date-format'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useUIStore } from '@/stores/ui'
import { resolveActorOnlineStatus } from '@/lib/actor-online'
import type { ActorRow } from '@/stores/actor-directory-store'
import { cn } from '@/lib/utils'
import { useCurrentTeamStore } from '@/stores/current-team'
import { canRemoveTeamActor, useTeamPermissions } from '@/lib/team-permissions'
import { externalSourceLabel } from '@/lib/external-actor-source'

interface Props {
  actor: ActorRow
  teamId?: string | null
  /** Called after a successful admin remove so directory lists can refresh. */
  onRemoved?: () => void
  /**
   * Dismiss the host. Set by the dialog (which renders a Close button and closes
   * itself after Start session / Remove); omitted by the main-column pane.
   */
  onClose?: () => void
  /**
   * Rendered at the end of the scrollable body. The main-column pane uses it for
   * the sessions list, which needs the room a modal does not have.
   */
  extraSections?: React.ReactNode
}

/**
 * The actor profile itself — avatar, presence, the details grid, client
 * versions, re-invite and remove — with no opinion about what contains it.
 *
 * Two hosts render it: `ActorDetailDialog` (sidebar rows, recents) and
 * `ActorDetailPane` (Contacts main column).
 */
export function ActorDetailContent({ actor, teamId, onRemoved, onClose, extraSections }: Props) {
  const { t } = useTranslation()
  const enterActorDraft = useUIStore((s) => s.enterActorDraft)
  const currentMemberId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)
  const teamPermissions = useTeamPermissions()
  const displayActor = actor

  const isAgent = displayActor.actor_type === 'agent'
  // A gateway contact (WeCom / Feishu / Discord / …). Neither teammate nor
  // agent: no role, no membership, and nothing on our side to start a session
  // with — the conversation lives in the channel they wrote from.
  const isExternal = displayActor.actor_type === 'external'
  const isMember = displayActor.actor_type === 'member'
  const agentPresence = useActorPresenceStore((s) =>
    isAgent ? s.byActorId[displayActor.id] : undefined,
  )

  const [reinviting, setReinviting] = React.useState(false)
  const [reinvite, setReinvite] = React.useState<{ deeplink: string; expiresAt: string } | null>(null)
  const [removeConfirmOpen, setRemoveConfirmOpen] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  // Per-device client versions live only on the single-actor detail fetch (the
  // directory list cache doesn't carry them), so we fetch lazily when the dialog
  // opens and enrich the cached row once it lands. Never blocks first paint.
  const [clientVersions, setClientVersions] = React.useState<ClientVersionEntry[]>([])
  const [detailAvatarUrl, setDetailAvatarUrl] = React.useState<string | null>(null)
  const [avatarFailed, setAvatarFailed] = React.useState(false)
  // Reset the re-invite result whenever this targets a different actor (or is
  // reopened) so a stale link from a previous actor never leaks through.
  React.useEffect(() => {
    setReinvite(null)
    setReinviting(false)
    setRemoveConfirmOpen(false)
    setRemoving(false)
  }, [actor.id])

  // Fetch the full actor detail (client versions + freshest avatar). Guarded so
  // a backend hiccup never breaks render.
  React.useEffect(() => {
    const id = actor.id
    setClientVersions([])
    setDetailAvatarUrl(null)
    setAvatarFailed(false)
    let cancelled = false
    void (async () => {
      try {
        const entry = await getBackend().actors.getActorDirectoryEntry(id)
        if (cancelled || !entry) return
        setClientVersions(entry.client_versions ?? [])
        if (entry.avatar_url) setDetailAvatarUrl(entry.avatar_url)
      } catch {
        // Detail enrichment is best-effort; keep the cached-row view.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [actor.id])

  const canRemove = teamId
    ? canRemoveTeamActor(teamPermissions, displayActor, currentMemberId)
    : false

  const confirmRemove = async () => {
    if (!teamId || !canRemove || removing) return
    setRemoving(true)
    try {
      await getBackend().teams.removeTeamActor(teamId, displayActor.id)
      toast.success(t('actors.removed', 'Removed from team'))
      setRemoveConfirmOpen(false)
      onClose?.()
      onRemoved?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(formatActorRemoveError(msg, t))
    } finally {
      setRemoving(false)
    }
  }

  const online = resolveActorOnlineStatus(displayActor, {
    currentMemberActorId: currentMemberId,
    agentPresence,
  })
  const c = actorAvatarColor(displayActor.id)
  const lastActive = displayActor.last_active_at
    ? formatRelativeTime(new Date(displayActor.last_active_at))
    : null
  const actorTypeLabel = isAgent
    ? t('actors.detail.agent', 'Agent')
    : isExternal
      ? t('actors.type.external', 'External contact')
      : t('actors.detail.member', 'Member')
  const onlineLabel = online
    ? t('actors.detail.online', 'Online')
    : (lastActive
      ? t('actors.detail.lastActive', 'Last active {{when}}', { when: lastActive })
      : t('actors.detail.offline', 'Offline'))
  // Members carry a team role; agents carry a Team/Personal visibility. They are
  // mutually exclusive — never show a member's status string in the "role" slot.
  const roleLabel = !isAgent && displayActor.team_role
    ? t(`actors.role.${displayActor.team_role}`, displayActor.team_role)
    : null
  const visibilityLabel = isAgent && displayActor.visibility
    ? (displayActor.visibility === 'personal'
      ? t('actors.visibility.personal', 'Personal')
      : t('actors.visibility.team', 'Team'))
    : null
  const subtitleText = isAgent
    ? (visibilityLabel ? `${actorTypeLabel} · ${visibilityLabel}` : actorTypeLabel)
    : (roleLabel ?? actorTypeLabel)
  // The full set of agent types this agent supports, with the active default
  // always included (even if the daemon's advertised agent_types happens to omit
  // it) so the current type never looks "unsupported". The default is marked in
  // the UI. Hidden when it would just repeat the single default type as noise.
  const supportedAgentTypes = isAgent
    ? Array.from(
        new Set(
          [displayActor.default_agent_type, ...(displayActor.agent_types ?? [])].filter(
            (tp): tp is string => !!tp,
          ),
        ),
      )
    : []
  const showSupportedAgentTypes = supportedAgentTypes.length > 1

  // Prefer the freshest avatar from the detail fetch, then the cached row. When
  // the image fails to load, fall back to the initials/icon placeholder.
  const avatarUrl = detailAvatarUrl ?? displayActor.avatar_url ?? null
  const showAvatarImage = !!avatarUrl && !avatarFailed
  // Group devices by client kind, newest report first within each kind.
  const sortedVersions = [...clientVersions].sort((a, b) => {
    if (a.clientType !== b.clientType) return a.clientType.localeCompare(b.clientType)
    return (b.lastReportedAt ?? '').localeCompare(a.lastReportedAt ?? '')
  })

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(displayActor.id)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const startSession = () => {
    if (displayActor.actor_type === 'external') return
    enterActorDraft({
      id: displayActor.id,
      displayName: displayActor.display_name,
      kind: displayActor.actor_type,
    })
    onClose?.()
  }

  const regenerateInvite = async () => {
    if (!teamId || reinviting) return
    setReinviting(true)
    try {
      // targetActorId rotates credentials on this existing agent actor instead
      // of minting a new one. Agents only: the member equivalent was removed in
      // 20260811110000 (the claim side could never be reached by the person it
      // was for), and the server now rejects a member invite that names a
      // target.
      const row = await getBackend().teams.createTeamInvite({
        teamId,
        kind: 'agent',
        displayName: displayActor.display_name,
        agentKind: 'daemon',
        ttlSeconds: null,
        targetActorId: displayActor.id,
      })
      if (!row.token) {
        toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg: 'empty response' }))
        return
      }
      setReinvite({
        // Not row.deeplink: that carries the backend's `amux://` scheme, which
        // no build registers with the OS.
        deeplink: buildInviteDeeplink(row.token),
        expiresAt: row.expiresAt ?? new Date(Date.now() + 604800 * 1000).toISOString(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t('invite.failed', 'Failed to create invite: {{msg}}', { msg }))
    } finally {
      setReinviting(false)
    }
  }

  const copyReinvite = async () => {
    if (!reinvite) return
    try {
      await navigator.clipboard.writeText(reinvite.deeplink)
    } catch {
      toast.error(t('invite.copyFailed', 'Failed to copy invite link'))
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-12">
          <div className="flex flex-col items-center text-center">
            <div className="relative">
              <div
                className={cn(
                  'flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden text-[38px] font-semibold text-white shadow-[0_8px_22px_-18px_rgba(26,26,20,0.45)]',
                  isAgent ? 'rounded-[24px] ring-[2px] ring-coral' : 'rounded-full',
                )}
                style={showAvatarImage ? undefined : { background: c.bg, color: c.fg }}
              >
                {showAvatarImage ? (
                  <img
                    src={avatarUrl ?? undefined}
                    alt={displayActor.display_name}
                    className="h-full w-full object-cover"
                    onError={() => setAvatarFailed(true)}
                  />
                ) : (
                  displayActor.display_name?.slice(0, 1).toUpperCase()
                    || (isAgent ? <Sparkles className="h-9 w-9" /> : <UserIcon className="h-9 w-9" />)
                )}
              </div>
              <span
                className={cn(
                  'absolute bottom-1 right-1 h-4 w-4 rounded-full ring-[3px] ring-background',
                  online ? 'bg-emerald-500' : 'bg-faint',
                )}
                aria-label={online ? t('actors.detail.online', 'Online') : t('actors.detail.offline', 'Offline')}
              />
            </div>

            <div className="mt-5 max-w-full truncate text-[24px] font-bold leading-tight text-foreground">
              {displayActor.display_name}
            </div>
            <div className="mt-2 text-[14px] leading-5 text-muted-foreground">
              {subtitleText}
            </div>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-border-soft bg-paper px-3 py-1.5 text-[12.5px] text-ink-2">
              <span className={cn('h-2 w-2 rounded-full', online ? 'bg-emerald-500' : 'bg-faint')} />
              <span>{onlineLabel}</span>
              {lastActive && (
                <>
                  <span className="text-faint">·</span>
                  <span className="font-mono text-[11.5px] text-faint">{lastActive}</span>
                </>
              )}
            </div>
          </div>

          <div className="mt-8 border-t border-border-soft pt-5">
            <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
              {t('actors.detail.details', 'Details')}
            </div>
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-5 gap-y-4 text-[13px] leading-5">
              {/* Members only: an external contact has no team role, so the row
                  would be a permanent em dash. */}
              {isMember && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.role', 'Role')}</dt>
                  <dd className="min-w-0 truncate text-foreground">{roleLabel ?? '—'}</dd>
                </>
              )}
              {!isAgent && displayActor.email && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.email', 'Email')}</dt>
                  <dd className="min-w-0 truncate text-foreground">
                    <a href={`mailto:${displayActor.email}`} className="hover:underline">{displayActor.email}</a>
                  </dd>
                </>
              )}
              {!isAgent && displayActor.phone && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.phone', 'Phone')}</dt>
                  <dd className="min-w-0 truncate text-foreground">
                    <a href={`tel:${displayActor.phone}`} className="hover:underline">{displayActor.phone}</a>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('actors.detail.type', 'Type')}</dt>
              <dd className="min-w-0 truncate text-foreground">{actorTypeLabel}</dd>
              {isExternal && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.source', 'Source')}</dt>
                  <dd className="min-w-0 truncate text-foreground">
                    {externalSourceLabel(displayActor.source, t)}
                  </dd>
                </>
              )}
              {isExternal && displayActor.source_id && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.sourceId', 'Source ID')}</dt>
                  <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">
                    {displayActor.source_id}
                  </dd>
                </>
              )}
              {isAgent && visibilityLabel && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.visibility', 'Visibility')}</dt>
                  <dd className="min-w-0 truncate text-foreground">{visibilityLabel}</dd>
                </>
              )}
              {isAgent && displayActor.default_agent_type && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.agentType', 'Agent type')}</dt>
                  <dd className="min-w-0 truncate text-foreground">{displayActor.default_agent_type}</dd>
                </>
              )}
              {isAgent && showSupportedAgentTypes && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.supportedAgentTypes', 'Supported types')}</dt>
                  <dd className="min-w-0 text-foreground">
                    <div className="flex flex-wrap gap-1.5">
                      {supportedAgentTypes.map((tp) => {
                        const isDefault = tp === displayActor.default_agent_type
                        return (
                          <span
                            key={tp}
                            className={cn(
                              'rounded-md border px-2 py-0.5 font-mono text-[11.5px]',
                              isDefault
                                ? 'border-coral text-coral'
                                : 'border-border-soft bg-paper text-ink-2',
                            )}
                            title={isDefault ? t('actors.detail.agentType', 'Agent type') : undefined}
                          >
                            {tp}
                          </span>
                        )
                      })}
                    </div>
                  </dd>
                </>
              )}
              {isAgent && displayActor.default_workspace_id && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.defaultWorkspace', 'Default workspace')}</dt>
                  <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">{displayActor.default_workspace_id}</dd>
                </>
              )}
              {displayActor.created_at && (
                <>
                  <dt className="text-muted-foreground">
                    {/* A gateway contact never "joined" anything — the row is the
                        first time they wrote in. */}
                    {isExternal
                      ? t('actors.detail.firstSeen', 'First seen')
                      : t('actors.detail.joined', 'Joined')}
                  </dt>
                  <dd className="min-w-0 truncate text-foreground">{formatDate(displayActor.created_at)}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('actors.detail.lastActiveLabel', 'Last active')}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">
                {lastActive ?? t('actors.detail.never', 'Never')}
              </dd>
              {teamId && (
                <>
                  <dt className="text-muted-foreground">{t('actors.detail.teamId', 'Team ID')}</dt>
                  <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">{teamId}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('actors.detail.actorId', 'Actor ID')}</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-foreground">{displayActor.id}</dd>
            </dl>
          </div>

          {sortedVersions.length > 0 && (
            <div className="mt-8 border-t border-border-soft pt-5">
              <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                {t('actors.detail.clientVersions', 'Client versions')}
              </div>
              <ul className="flex flex-col gap-2.5">
                {sortedVersions.map((v) => (
                  <li
                    key={`${v.clientType}:${v.deviceId}`}
                    className="flex items-center justify-between gap-3 text-[13px] leading-5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="rounded-md border border-border-soft bg-paper px-2 py-0.5 font-mono text-[11.5px] text-ink-2">
                        {v.clientType}
                      </span>
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {v.version}
                        {v.build ? <span className="ml-1 text-muted-foreground">({v.build})</span> : null}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-faint">
                      {v.lastReportedAt && (
                        <span>{formatRelativeTime(new Date(v.lastReportedAt))}</span>
                      )}
                      <span className="font-mono" title={v.deviceId}>
                        {v.deviceId.length > 8 ? `${v.deviceId.slice(0, 8)}…` : v.deviceId}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Agents only. Member re-invite was removed in 20260811110000. */}
          {teamId && isAgent && (
            <div className="mt-8 border-t border-border-soft pt-5">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                {t('actors.reinvite.title', 'Re-invite')}
              </div>
              <p className="mb-4 text-[12px] leading-5 text-muted-foreground">
                {t('actors.reinvite.agentHint', 'Use this if the daemon was wiped and needs to re-pair.')}
              </p>
              {reinvite ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Input value={reinvite.deeplink} readOnly className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => void copyReinvite()}
                      title={t('invite.copy', 'Copy')}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t('invite.expiresAt', 'Expires {{date}}', {
                      date: new Date(reinvite.expiresAt).toLocaleString(),
                    })}
                  </p>
                </div>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => void regenerateInvite()}
                  disabled={reinviting}
                  className="h-9 rounded-[9px] border-border-soft bg-background text-[13px]"
                >
                  {reinviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  {t('actors.reinvite.agentButton', 'Regenerate invite link')}
                </Button>
              )}
            </div>
          )}

          {canRemove && (
            <div className="mt-8 border-t border-border-soft pt-5">
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                {t('actors.detail.removeSection', 'Remove from team')}
              </div>
              <p className="mb-4 text-[12px] leading-5 text-muted-foreground">
                {isAgent
                  ? t('actors.detail.removeAgentHint', 'Permanently remove this agent and its credentials from the team.')
                  : t('actors.detail.removeMemberHint', 'Permanently remove this member from the team. They will lose access to all sessions and shared resources.')}
              </p>
              <Button
                variant="outline"
                onClick={() => setRemoveConfirmOpen(true)}
                disabled={removing}
                className="h-9 rounded-[9px] border-destructive/30 bg-background text-[13px] text-destructive hover:bg-destructive/5"
              >
                {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserMinus className="h-4 w-4" />}
                {isAgent
                  ? t('actors.detail.removeAgent', 'Remove agent')
                  : t('actors.detail.removeMember', 'Remove member')}
              </Button>
            </div>
          )}

          {extraSections}
        </div>

      <div className="flex shrink-0 flex-row items-center justify-between gap-3 border-t border-border-soft bg-paper px-6 py-4">
          {isExternal ? (
            <span className="flex-1 text-[12px] leading-5 text-muted-foreground">
              {t(
                'actors.detail.externalNoSession',
                'Reachable only through the channel they wrote from.',
              )}
            </span>
          ) : (
            <Button
              onClick={startSession}
              className="h-10 flex-1 rounded-[9px] bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              <MessageCircle className="h-4 w-4" />
              {t('actors.detail.startSession', 'Start session')}
            </Button>
          )}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={copyId}
              className="h-10 w-10 rounded-[9px] border-border-soft bg-background"
              aria-label={t('actors.detail.copyId', 'Copy ID')}
            >
              <Copy className="h-4 w-4" />
            </Button>
            {onClose && (
              <Button
                variant="outline"
                size="icon"
                onClick={onClose}
                className="h-10 w-10 rounded-[9px] border-border-soft bg-background"
                aria-label={t('common.close', 'Close')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
      </div>

      <AlertDialog open={removeConfirmOpen} onOpenChange={setRemoveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isAgent
                ? t('actors.removeConfirm.titleAgent', 'Remove agent?')
                : t('actors.removeConfirm.titleMember', 'Remove member?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('actors.removeConfirm.body', 'Remove {{name}} from the team. This cannot be undone.', {
                name: displayActor.display_name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRemove()} disabled={removing}>
              {t('actors.removeConfirm.cta', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
