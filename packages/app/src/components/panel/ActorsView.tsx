import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Filter, Loader2, Plus, Search, Sparkles, Star, User as UserIcon, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { InviteActorDialog } from '@/components/sidebar/InviteActorDialog'
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
import { formatActorRemoveError } from '@/lib/actor-remove-error'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { actorAvatarColor } from '@/lib/actor-color'
import { formatRelativeTimeShort } from '@/lib/date-format'
import { externalSourceLabel } from '@/lib/external-actor-source'
import { useActorDetailStore } from '@/stores/actor-detail-store'
import { cn } from '@/lib/utils'
import {
  useActorDirectory,
  resolveActorOnlineStatus,
  type ActorRow,
} from '@/stores/actor-directory-store'
import { useCurrentTeamStore } from '@/stores/current-team'

/**
 * `all` deliberately means "everyone on the team" — members and agents — and NOT
 * external gateway contacts. A team that talks to customers over WeCom
 * accumulates one external actor per person who ever wrote in, which buried the
 * actual teammates. They are one filter click away instead.
 */
export type ActorTypeFilter = 'all' | 'agent' | 'member' | 'external'

/** Whether a row survives the type filter. Exported so the rule is unit-testable
 *  without driving the filter popover. */
export function matchesActorTypeFilter(
  actorType: ActorRow['actor_type'],
  filter: ActorTypeFilter,
): boolean {
  if (filter === 'all') return actorType !== 'external'
  return actorType === filter
}

const actorNameCollator = new Intl.Collator(['zh-Hans-CN', 'en'], {
  sensitivity: 'base',
  numeric: true,
})

/** Elevated team roles shown as a pill beside the display name (not in subtitle). */
export function memberTeamRolePill(
  teamRole: string | null | undefined,
): 'owner' | 'admin' | null {
  if (teamRole === 'owner' || teamRole === 'admin') return teamRole
  return null
}

/** Members sort: owner → admin → everyone else, alphabetical within each tier. */
export function compareMembersByRoleThenName(a: ActorRow, b: ActorRow): number {
  const roleRank = (role: string | null | undefined) => {
    if (role === 'owner') return 0
    if (role === 'admin') return 1
    return 2
  }
  const rankDiff = roleRank(a.team_role) - roleRank(b.team_role)
  if (rankDiff !== 0) return rankDiff
  return actorNameCollator.compare(a.display_name, b.display_name)
}

function sortMembersByRoleThenName(list: ActorRow[]): ActorRow[] {
  return [...list].sort(compareMembersByRoleThenName)
}

function ActorSectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-[1] bg-gradient-to-b from-background from-70% to-transparent px-4 pb-1.5 pt-[13px] text-[9.5px] font-semibold uppercase tracking-[0.6px] text-faint">
      {label}{' '}
      <span className="font-mono font-normal">· {count}</span>
    </div>
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
  const rolePill = memberTeamRolePill(actor.team_role)
  const initial = actor.display_name?.trim().slice(0, 1).toUpperCase() || ''
  const colors = actorAvatarColor(actor.id)
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
          style={{ backgroundColor: colors.bg, color: colors.fg }}
        >
          {initial || <UserIcon className="h-4 w-4" />}
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

function FilterRow({
  active,
  count,
  dotClassName,
  label,
  onSelect,
}: {
  active: boolean
  count: number
  dotClassName?: string
  label: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[8px] px-3 py-1.5 text-left text-[12.5px] font-semibold text-foreground',
        active && 'bg-coral-soft/35',
      )}
    >
      {dotClassName ? <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClassName)} /> : <span className="w-2" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-[11.5px] font-normal text-faint">{count}</span>
      {active && <Check className="h-3.5 w-3.5 text-coral" />}
    </button>
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
  const [filter, setFilter] = React.useState<ActorTypeFilter>('all')
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [removeFor, setRemoveFor] = React.useState<ActorRow | null>(null)
  const [removing, setRemoving] = React.useState(false)

  const counts = React.useMemo(() => {
    const agent = actors.filter((actor) => actor.actor_type === 'agent').length
    const member = actors.filter((actor) => actor.actor_type === 'member').length
    const external = actors.filter((actor) => actor.actor_type === 'external').length
    // `all` is members + agents, matching what the unfiltered list renders.
    return { all: agent + member, agent, member, external }
  }, [actors])

  const visibleSections = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const matchesQuery = (actor: ActorRow) =>
      !normalizedQuery || actor.display_name.toLowerCase().includes(normalizedQuery)
    const sortByName = (list: ActorRow[]) =>
      [...list].sort((a, b) => actorNameCollator.compare(a.display_name, b.display_name))

    const members = sortMembersByRoleThenName(
      actors.filter((a) => a.actor_type === 'member' && matchesActorTypeFilter('member', filter) && matchesQuery(a)),
    )
    const agents = sortByName(
      actors.filter((a) => a.actor_type === 'agent' && matchesActorTypeFilter('agent', filter) && matchesQuery(a)),
    )
    const externals = sortByName(
      actors.filter((a) => a.actor_type === 'external' && matchesActorTypeFilter('external', filter) && matchesQuery(a)),
    )

    return { members, agents, externals }
  }, [actors, filter, query])

  const visibleActors = React.useMemo(
    () => [...visibleSections.members, ...visibleSections.agents, ...visibleSections.externals],
    [visibleSections],
  )

  const showSectionHeaders = filter === 'all'
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
        </div>
      )
    }

    if (visibleActors.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t('actors.noMatches', 'No matching actors')}
        </div>
      )
    }

    return (
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {visibleSections.members.length > 0 && (
          <>
            {showSectionHeaders && (
              <ActorSectionLabel
                label={t('actors.type.member', 'Team')}
                count={visibleSections.members.length}
              />
            )}
            {visibleSections.members.map((a) => (
              <ActorRowView
                key={a.id}
                actor={a}
                selected={selectedActorId === a.id}
                onOpen={openActor}
                onViewProfile={openActor}
                onRequestRemove={setRemoveFor}
              />
            ))}
          </>
        )}
        {visibleSections.agents.length > 0 && (
          <>
            {showSectionHeaders && (
              <ActorSectionLabel
                label={t('actors.type.agent', 'Agent')}
                count={visibleSections.agents.length}
              />
            )}
            {visibleSections.agents.map((a) => (
              <ActorRowView
                key={a.id}
                actor={a}
                selected={selectedActorId === a.id}
                onOpen={openActor}
                onViewProfile={openActor}
                onRequestRemove={setRemoveFor}
              />
            ))}
          </>
        )}
        {visibleSections.externals.length > 0 && (
          <>
            {showSectionHeaders && (
              <ActorSectionLabel
                label={t('actors.type.external', 'External')}
                count={visibleSections.externals.length}
              />
            )}
            {visibleSections.externals.map((a) => (
              <ActorRowView
                key={a.id}
                actor={a}
                selected={selectedActorId === a.id}
                onOpen={openActor}
                onViewProfile={openActor}
                onRequestRemove={setRemoveFor}
              />
            ))}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="border-b border-border px-4 py-3" data-tauri-drag-region>
        <div className="flex items-center gap-2">
          {sidebarCollapsed && (
            <div className="flex items-center gap-1 shrink-0">
              <TrafficLights />
              <SidebarCollapseToggle />
            </div>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-7 text-foreground">
            {t('actors.contactsTitle', 'Contacts')}
            <span className="ml-2 font-mono text-[12.5px] font-normal text-faint">· {visibleActors.length}</span>
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
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 rounded-[8px] text-muted-foreground hover:bg-selected hover:text-foreground"
                aria-label={t('actors.filterType', 'Filter by type')}
              >
                <Filter className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[260px] rounded-[14px] border-border bg-paper p-2 shadow-[0_18px_45px_-28px_rgba(26,26,20,0.45)]">
              <div className="px-3 pb-1 pt-1 text-[11.5px] font-semibold text-faint">{t('actors.typeFilterLabel', 'Type')}</div>
              <FilterRow active={filter === 'all'} count={counts.all} label={t('common.all', 'All')} onSelect={() => setFilter('all')} />
              <FilterRow active={filter === 'agent'} count={counts.agent} dotClassName="bg-coral" label={t('actors.type.agent', 'Agent')} onSelect={() => setFilter('agent')} />
              <FilterRow active={filter === 'member'} count={counts.member} dotClassName="bg-emerald-500" label={t('actors.type.member', 'Team')} onSelect={() => setFilter('member')} />
              {/* Only offered when the team actually has gateway contacts —
                  otherwise it is a row that can only ever say 0. */}
              {counts.external > 0 && (
                <FilterRow active={filter === 'external'} count={counts.external} dotClassName="bg-sky-500" label={t('actors.type.external', 'External')} onSelect={() => setFilter('external')} />
              )}
            </PopoverContent>
          </Popover>
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
