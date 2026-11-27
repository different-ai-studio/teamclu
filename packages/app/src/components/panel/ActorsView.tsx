import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Monitor, Plus, Search, Sparkles, Star, User as UserIcon, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QuickFilterChips } from '@/components/ui/quick-filter-chips'
import { InviteActorDialog } from '@/components/sidebar/InviteActorDialog'
import { AnotherComputerAgentDialog } from '@/components/sidebar/AnotherComputerAgentDialog'
import { ActorContextMenu } from '@/components/sidebar/ActorContextMenu'
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
import { getBackend } from '@/lib/backend'
import { formatActorRemoveError } from '@/lib/actor/actor-remove-error'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { actorAvatarColor } from '@/lib/actor/actor-color'
import { formatRelativeTimeShort } from '@/lib/ui/date-format'
import { externalSourceLabel } from '@/lib/actor/external-actor-source'
import { useActorDetailStore } from '@/stores/actor-detail-store'
import { cn } from '@/lib/utils'
import {
  useActorDirectory,
  resolveActorOnlineStatus,
  type ActorRow,
} from '@/stores/actor-directory-store'
import { useCurrentTeamStore } from '@/stores/current-team'

/**
 * The contacts tabs: 团队 · 智能体, plus 外部成员 once the team has any.
 *
 * One kind at a time, like the apps list above it, rather than one long list
 * cut by section headers behind a filter popover. External gateway contacts
 * get a tab of their own and nothing more: a team that talks to customers over
 * WeCom accumulates one per person who ever wrote in, which buried the actual
 * teammates when they shared a list.
 */
type ActorTab = 'member' | 'agent' | 'external'

const actorNameCollator = new Intl.Collator(['zh-Hans-CN', 'en'], {
  sensitivity: 'base',
  numeric: true,
})

function memberHasRoleCode(
  actor: Pick<ActorRow, 'roles' | 'team_role'>,
  code: string,
): boolean {
  if (actor.roles?.some((r) => r.code === code)) return true
  // Cold cache / legacy rows may only carry the derived highest role.
  if (!actor.roles?.length && actor.team_role === code) return true
  return false
}

/** Elevated team roles shown as a pill beside the display name (not in subtitle). */
export function memberTeamRolePill(
  actor: Pick<ActorRow, 'roles' | 'team_role'> | string | null | undefined,
): 'owner' | 'admin' | null {
  // Legacy call sites passed a bare team_role string.
  if (typeof actor === 'string' || actor == null) {
    if (actor === 'owner' || actor === 'admin') return actor
    return null
  }
  if (memberHasRoleCode(actor, 'owner')) return 'owner'
  if (memberHasRoleCode(actor, 'admin')) return 'admin'
  return null
}

/** Members sort: has owner → has admin → everyone else, alphabetical within each tier. */
export function compareMembersByRoleThenName(a: ActorRow, b: ActorRow): number {
  const roleRank = (actor: ActorRow) => {
    if (memberHasRoleCode(actor, 'owner')) return 0
    if (memberHasRoleCode(actor, 'admin')) return 1
    return 2
  }
  const rankDiff = roleRank(a) - roleRank(b)
  if (rankDiff !== 0) return rankDiff
  return actorNameCollator.compare(a.display_name, b.display_name)
}

function sortMembersByRoleThenName(list: ActorRow[]): ActorRow[] {
  return [...list].sort(compareMembersByRoleThenName)
}

function AnotherComputerRow({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 border-b border-border-soft px-4 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-selected focus:outline-none focus-visible:bg-selected"
    >
      <Monitor className="h-4 w-4 shrink-0" />
      <span>{t('actors.anotherComputer', 'Run on another computer')}</span>
    </button>
  )
}

function MemberActorRowView({
  actor,
  selected,
  onOpen,
  onViewProfile,
  onRequestRemove,
}: {
  actor: ActorRow
  selected: boolean
  onOpen: (actor: ActorRow) => void
  onViewProfile: (actor: ActorRow) => void
  onRequestRemove: (actor: ActorRow) => void
}) {
  const { t } = useTranslation()
  const currentMemberActorId = useCurrentTeamStore((s) => s.currentMember?.id ?? null)
  const online = resolveActorOnlineStatus(actor, { currentMemberActorId })
  const rolePill = memberTeamRolePill(actor)
  const initial = actor.display_name?.trim().slice(0, 1).toUpperCase() || ''
  const colors = actorAvatarColor(actor.id)
  // Remember which URL failed rather than a flag, so a newly uploaded photo
  // (a fresh URL) gets its own try instead of staying on the initial.
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null)
  const avatarUrl = actor.avatar_url && actor.avatar_url !== failedAvatarUrl ? actor.avatar_url : null
  const lastActive = actor.last_active_at ? formatRelativeTimeShort(new Date(actor.last_active_at)) : ''

  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(actor.id)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  return (
    <ActorContextMenu
      actor={actor}
      isDefault={false}
      onViewDetail={onViewProfile}
      onCopyName={handleCopyName}
      onCopyId={handleCopyId}
      onRequestRemove={onRequestRemove}
    >
      <button
        type="button"
        onClick={() => onOpen(actor)}
        className={cn(
          'flex w-full items-center gap-2.5 border-b border-border-soft px-4 py-2.5 text-left hover:bg-selected focus:outline-none focus-visible:bg-selected',
          selected && 'bg-selected',
        )}
      >
        <div
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[16px] font-semibold text-white"
          style={avatarUrl ? undefined : { backgroundColor: colors.bg, color: colors.fg }}
        >
          {avatarUrl ? (
            // Decorative: the name sits right beside it.
            <img
              src={avatarUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full rounded-full object-cover"
              onError={() => setFailedAvatarUrl(avatarUrl)}
            />
          ) : (
            initial || <UserIcon className="h-4 w-4" />
          )}
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-background',
              online ? 'bg-emerald-500' : 'bg-faint',
            )}
            aria-label={online ? 'online' : 'offline'}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold leading-[19px] text-foreground">{actor.display_name}</span>
            {rolePill && (
              <span className="shrink-0 rounded bg-panel px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
                {t(
                  `actors.role.${rolePill}`,
                  rolePill === 'owner' ? 'Owner' : 'Admin',
                )}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] leading-[18px] text-muted-foreground">
            {t('actors.role.member', 'Member')}
          </div>
        </div>
        {lastActive && <span className="ml-2 shrink-0 font-mono text-[11.5px] text-faint">{lastActive}</span>}
      </button>
    </ActorContextMenu>
  )
}

function AgentActorRowView({
  actor,
  selected,
  onOpen,
  onViewProfile,
  onRequestRemove,
}: {
  actor: ActorRow
  selected: boolean
  onOpen: (actor: ActorRow) => void
  onViewProfile: (actor: ActorRow) => void
  onRequestRemove: (actor: ActorRow) => void
}) {
  const { t } = useTranslation()
  const isDefaultAgent = useMemberPreferencesStore((s) => s.defaultAgentId === actor.id)
  const initial = actor.display_name?.trim().slice(0, 1).toUpperCase() || ''
  const colors = actorAvatarColor(actor.id)
  const lastActive = actor.last_active_at ? formatRelativeTimeShort(new Date(actor.last_active_at)) : ''
  const subtitle = actor.visibility === 'personal'
    ? t('actors.visibility.personalAgent', 'Personal Agent')
    : actor.visibility === 'team'
      ? t('actors.visibility.teamAgent', 'Team Agent')
      : t('actors.type.agent', 'Agent')

  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(actor.id)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  return (
    <ActorContextMenu
      actor={actor}
      isDefault={isDefaultAgent}
      onViewDetail={onViewProfile}
      onCopyName={handleCopyName}
      onCopyId={handleCopyId}
      onRequestRemove={onRequestRemove}
    >
      <button
        type="button"
        onClick={() => onOpen(actor)}
        className={cn(
          'flex w-full items-center gap-2.5 border-b border-border-soft px-4 py-2.5 text-left hover:bg-selected focus:outline-none focus-visible:bg-selected',
          selected && 'bg-selected',
        )}
      >
        <div
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] text-[16px] font-semibold text-white ring-[1.5px] ring-coral"
          style={{ backgroundColor: colors.bg, color: colors.fg }}
        >
          {initial || <Sparkles className="h-4 w-4" />}
          <span className="absolute -bottom-1 -right-1 rounded border border-coral bg-paper px-1 py-px font-mono text-[8px] font-bold leading-tight text-coral">
            AI
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold leading-[19px] text-foreground">{actor.display_name}</span>
            {isDefaultAgent && (
              <Star
                className="h-3 w-3 shrink-0 fill-coral text-coral"
                aria-label={t('actors.defaultAgent', 'Default agent')}
              />
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] leading-[18px] text-muted-foreground">{subtitle}</div>
        </div>
        {lastActive && <span className="ml-2 shrink-0 font-mono text-[11.5px] text-faint">{lastActive}</span>}
      </button>
    </ActorContextMenu>
  )
}

function ExternalActorRowView({
  actor,
  selected,
  onOpen,
  onViewProfile,
  onRequestRemove,
}: {
  actor: ActorRow
  selected: boolean
  onOpen: (actor: ActorRow) => void
  onViewProfile: (actor: ActorRow) => void
  onRequestRemove: (actor: ActorRow) => void
}) {
  const { t } = useTranslation()
  const initial = actor.display_name?.trim().slice(0, 1).toUpperCase() || ''
  const colors = actorAvatarColor(actor.id)
  const lastActive = actor.last_active_at ? formatRelativeTimeShort(new Date(actor.last_active_at)) : ''
  const subtitle = actor.source
    ? `${t('actors.type.external', 'External')} · ${externalSourceLabel(actor.source, t)}`
    : t('actors.type.external', 'External')

  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(actor.display_name)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(actor.id)
    } catch {
      toast.error(t('actors.copyFailed', 'Copy failed'))
    }
  }

  return (
    <ActorContextMenu
      actor={actor}
      isDefault={false}
      onViewDetail={onViewProfile}
      onCopyName={handleCopyName}
      onCopyId={handleCopyId}
      onRequestRemove={onRequestRemove}
    >
      <button
        type="button"
        onClick={() => onOpen(actor)}
        className={cn(
          'flex w-full items-center gap-2.5 border-b border-border-soft px-4 py-2.5 text-left hover:bg-selected focus:outline-none focus-visible:bg-selected',
          selected && 'bg-selected',
        )}
      >
        <div
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[16px] font-semibold text-white"
          style={{ backgroundColor: colors.bg, color: colors.fg }}
        >
          {initial || <UserIcon className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-[19px] text-foreground">{actor.display_name}</div>
          <div className="mt-0.5 truncate text-[11.5px] leading-[18px] text-muted-foreground">{subtitle}</div>
        </div>
        {lastActive && <span className="ml-2 shrink-0 font-mono text-[11.5px] text-faint">{lastActive}</span>}
      </button>
    </ActorContextMenu>
  )
}

function ActorRowView({
  actor,
  selected,
  onOpen,
  onViewProfile,
  onRequestRemove,
}: {
  actor: ActorRow
  selected: boolean
  onOpen: (actor: ActorRow) => void
  onViewProfile: (actor: ActorRow) => void
  onRequestRemove: (actor: ActorRow) => void
}) {
  if (actor.actor_type === 'agent') {
    return (
      <AgentActorRowView
        actor={actor}
        selected={selected}
        onOpen={onOpen}
        onViewProfile={onViewProfile}
        onRequestRemove={onRequestRemove}
      />
    )
  }
  if (actor.actor_type === 'external') {
    return (
      <ExternalActorRowView
        actor={actor}
        selected={selected}
        onOpen={onOpen}
        onViewProfile={onViewProfile}
        onRequestRemove={onRequestRemove}
      />
    )
  }
  return (
    <MemberActorRowView
      actor={actor}
      selected={selected}
      onOpen={onOpen}
      onViewProfile={onViewProfile}
      onRequestRemove={onRequestRemove}
    />
  )
}

export function ActorsView() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const { actors, loading, error, teamId, refetch } = useActorDirectory()
  const ensureDefaultAgentLoaded = useMemberPreferencesStore((s) => s.ensureLoaded)

  React.useEffect(() => {
    if (teamId) void ensureDefaultAgentLoaded(teamId)
  }, [teamId, ensureDefaultAgentLoaded])

  // Opening the "All actors" panel kicks one background reconcile so a teammate's
  // recent change (e.g. an agent flipped team→personal, which the server already
  // filters out for other viewers) shows up immediately instead of lingering until
  // the next 60s periodic poll. The panel only mounts while the sidebar filter is
  // `actors` (SidebarSecondColumn), so this fires each time it's shown. refetch()
  // keeps the current list visible — no spinner — and swaps in the fresh result
  // when it lands. The very first mount is already covered by the store's initial
  // load (this extra call coalesces via the in-flight guard); reopens are where it
  // does real work.
  React.useEffect(() => {
    if (teamId) refetch()
  }, [teamId, refetch])
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [tab, setTab] = React.useState<ActorTab>('member')
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [anotherComputerOpen, setAnotherComputerOpen] = React.useState(false)
  const [removeFor, setRemoveFor] = React.useState<ActorRow | null>(null)
  const [removing, setRemoving] = React.useState(false)

  const counts = React.useMemo(() => {
    const agent = actors.filter((actor) => actor.actor_type === 'agent').length
    const member = actors.filter((actor) => actor.actor_type === 'member').length
    const external = actors.filter((actor) => actor.actor_type === 'external').length
    // The header counts the team — members and agents, not external contacts.
    return { team: agent + member, agent, member, external }
  }, [actors])

  // A team whose last external contact was removed while that tab was open
  // has nothing left to show there.
  React.useEffect(() => {
    if (tab === 'external' && counts.external === 0 && !loading) setTab('member')
  }, [tab, counts.external, loading])

  const visibleActors = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const inTab = actors.filter(
      (a) => a.actor_type === tab && (!normalizedQuery || a.display_name.toLowerCase().includes(normalizedQuery)),
    )
    if (tab === 'member') return sortMembersByRoleThenName(inTab)
    return [...inTab].sort((a, b) => actorNameCollator.compare(a.display_name, b.display_name))
  }, [actors, tab, query])

  const showAnotherComputer = tab === 'agent' && query.trim() === ''
  const openActorDetail = useActorDetailStore((s) => s.openActor)
  const clearActorDetail = useActorDetailStore((s) => s.clearDetail)
  const selectedActorId = useActorDetailStore((s) => s.actorId)

  const openActor = React.useCallback((actor: ActorRow) => {
    openActorDetail(actor.id)
  }, [openActorDetail])

  const confirmRemove = async () => {
    if (!removeFor || !teamId) return
    setRemoving(true)
    try {
      await getBackend().teams.removeTeamActor(teamId, removeFor.id)
      toast.success(t('actors.removed', 'Removed from team'))
      setRemoveFor(null)
      if (useActorDetailStore.getState().actorId === removeFor.id) {
        clearActorDetail()
      }
      refetch()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(formatActorRemoveError(msg, t))
    } finally {
      setRemoving(false)
    }
  }

  const removeIsAgent = removeFor?.actor_type === 'agent'

  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mb-2 h-5 w-5 animate-spin" />
          <span>{t('actors.loading', 'Loading actors...')}</span>
        </div>
      )
    }

    if (error) {
      return (
        <div className="px-4 py-3 text-sm text-destructive">{t('actors.error', 'Failed to load actors')}</div>
      )
    }

    if (actors.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
          <Users className="mb-2 h-8 w-8 text-muted-foreground" />
          <span>{t('actors.empty', 'No actors in this team yet')}</span>
          {showAnotherComputer ? (
            <AnotherComputerRow onClick={() => setAnotherComputerOpen(true)} />
          ) : null}
        </div>
      )
    }

    if (visibleActors.length === 0 && !showAnotherComputer) {
      return (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('actors.noMatches', 'No matching actors')}
        </div>
      )
    }

    return (
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {visibleActors.map((a) => (
          <ActorRowView
            key={a.id}
            actor={a}
            selected={selectedActorId === a.id}
            onOpen={openActor}
            onViewProfile={openActor}
            onRequestRemove={setRemoveFor}
          />
        ))}
        {showAnotherComputer ? <AnotherComputerRow onClick={() => setAnotherComputerOpen(true)} /> : null}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="border-b border-border px-4 py-3" data-tauri-drag-region="deep">
        <div className="flex items-center gap-2">
          {sidebarCollapsed && (
            <div className="flex items-center gap-1 shrink-0">
              <TrafficLights />
              <SidebarCollapseToggle />
            </div>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-7 text-foreground">
            {t('actors.contactsTitle', 'Contacts')}
            <span className="ml-2 font-mono text-[12.5px] font-normal text-faint">· {counts.team}</span>
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn('h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground', searchOpen && 'bg-selected text-foreground')}
            aria-label={t('common.search', 'Search')}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
            aria-label={t('actors.invite', 'Invite actor')}
            onClick={() => setInviteOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <QuickFilterChips
          value={tab}
          onChange={setTab}
          ariaLabel={t('actors.filterType', 'Filter by type')}
          testIdPrefix="actor-tab"
          className="-ml-2 mt-2"
          chips={[
            { value: 'member' as const, label: t('actors.type.member', 'Team'), count: counts.member },
            { value: 'agent' as const, label: t('actors.type.agent', 'Agent'), count: counts.agent },
            // Only once the team actually has gateway contacts — otherwise it
            // is a tab that can only ever say 0.
            ...(counts.external > 0
              ? [{ value: 'external' as const, label: t('actors.type.external', 'External'), count: counts.external }]
              : []),
          ]}
        />
        {searchOpen && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('actors.searchPlaceholder', 'Search actors')}
            className="mt-2 h-8 w-full rounded-[8px] border border-border bg-paper px-3 text-[12.5px] outline-none placeholder:text-faint focus:border-border"
          />
        )}
      </div>
      {renderBody()}
      <InviteActorDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <AnotherComputerAgentDialog open={anotherComputerOpen} onOpenChange={setAnotherComputerOpen} />
      <AlertDialog open={!!removeFor} onOpenChange={(open) => { if (!open) setRemoveFor(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removeIsAgent
                ? t('actors.removeConfirm.titleAgent', 'Remove agent?')
                : t('actors.removeConfirm.titleMember', 'Remove member?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('actors.removeConfirm.body', 'Remove {{name}} from the team. This cannot be undone.', { name: removeFor?.display_name })}
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
    </div>
  )
}
