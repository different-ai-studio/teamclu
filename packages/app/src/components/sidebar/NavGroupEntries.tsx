import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Bookmark } from 'lucide-react'
import { useUIStore, type SidebarFilter } from '@/stores/ui'
import { navGroupEntryFilter, navGroupMemberOf, type NavGroupId } from '@/lib/layout/nav-groups'
import { useTeamConflictsStore } from '@/stores/team-conflicts'
import { TEAM_SYNCED_EVENT } from '@/lib/config/build-config'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { cn } from '@/lib/utils'
import { NAV_ROW_TRAILING_SLOT } from '@/components/sidebar/nav-row'
import { navRowBox, navRowIcon, navRowLabel, navRowSignal, useNavRailMode } from '@/components/sidebar/nav-rail-mode'

/**
 * Prefetches every team-share catalog once. Split out of the rows because the
 * nav renders team-share entries in two places (default group + 高级 group) and
 * the catalogs must still be fetched exactly once per team/workspace.
 *
 * Not gated on a workspace. Team-share content is the team's: skills and MCP
 * come from the registry (plus the selected Agent over RPC), knowledge from the
 * team's own directory under the amuxd home. The old `!workspacePath` guard
 * meant a client with no folder open showed empty sections rather than unloaded.
 *
 * `workspacePath` stays in the deps: opening a folder adds this machine's local
 * rows (personal skills / MCP), so the catalogs have to be read again.
 *
 * `loadCounts` uses `allSettled`, so a section that does still need a workspace
 * — Env, whose catalog read throws without one — cannot take the others down.
 */
export function useTeamShareCountsLoader(): void {
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const loadCounts = useTeamShareBrowserStore((s) => s.loadCounts)

  React.useEffect(() => {
    if (!currentTeamId) return
    void loadCounts()
  }, [currentTeamId, workspacePath, loadCounts])
}

interface RowProps {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  /** Items in this section that have stopped and need a decision. */
  needsAttention?: number
  attentionLabel?: string
  onClick: () => void
}

function SectionRow({
  label,
  icon: Icon,
  active,
  needsAttention = 0,
  attentionLabel,
  onClick,
}: RowProps) {
  const mode = useNavRailMode()
  return (
    <button
      type="button"
      onClick={onClick}
      title={mode === 'rail-collapsed' ? label : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg text-left text-[13px] transition-[background-color,box-shadow,color] duration-150',
        navRowBox(mode),
        active
          ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
          : 'text-ink-2 hover:bg-black/[0.04]',
      )}
    >
      <Icon className={cn(navRowIcon(mode), active ? 'text-foreground' : 'text-muted-foreground')} />
      <span className={navRowLabel(mode)}>{label}</span>
      {/*
        The one thing in this panel that reaches out. Auto-follow means a member
        may never open the skills section, so a paused update has no other way
        to be noticed — a full-ink dot is enough contrast without spending the
        brand accent on it.
      */}
      {needsAttention > 0 ? (
        <span className={cn(NAV_ROW_TRAILING_SLOT, navRowSignal(mode))}>
          <span
            className="h-1.5 w-1.5 rounded-full bg-foreground"
            aria-label={attentionLabel}
            title={attentionLabel}
          />
        </span>
      ) : null}
    </button>
  )
}

/**
 * Opens one member of a grouped destination. Team-share sections also need
 * their catalog refreshed and, for skills, a default detail view; the rail
 * tile and column two's switch both go through here so they behave the same.
 */
export function useSelectNavGroupMember(): (filter: SidebarFilter) => void {
  const setFilter = useUIStore((s) => s.setSidebarFilter)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  return React.useCallback(
    (filter: SidebarFilter) => {
      setFilter(filter)
      if (filter.kind !== 'teamShare') return
      const section = filter.section
      void loadSection(section, { force: true, withTools: section === 'mcp' })
      // Skills with nothing selected used to leave the main column blank. Default
      // to the marketplace browse view — same entry as the store button, so the
      // list header stays consistent with what's on the right.
      if (section === 'skills') {
        const detail = useTeamShareBrowserStore.getState().detailTarget
        const skillSelected =
          detail?.kind === 'skill' ||
          detail?.kind === 'skill-file' ||
          detail?.kind === 'marketplace' ||
          detail?.kind === 'marketplace-item'
        if (!skillSelected) {
          useTeamShareBrowserStore.getState().openDetail({ kind: 'marketplace' })
        }
      }
    },
    [setFilter, loadSection],
  )
}

const GROUP_DEFS: Record<NavGroupId, { icon: React.ComponentType<{ className?: string }>; labelKey: string; fallback: string }> = {
  knowledge: { icon: Bookmark, labelKey: 'sidebar.groupKnowledge', fallback: 'Knowledge' },
  abilities: { icon: Sparkles, labelKey: 'sidebar.groupAbilities', fallback: 'Abilities' },
}

/**
 * The two grouped rail entries: 知识 (knowledge base + ideas) and 能力 (skills,
 * MCP, secrets). Each opens the member last used in it; column two's switch
 * moves between members. Each tile carries its members' attention dot.
 */
export function NavGroupEntries() {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const embedMode = useUIStore((s) => s.embedMode)
  const navGroupLast = useUIStore((s) => s.navGroupLast)
  const select = useSelectNavGroupMember()
  const activeGroup = navGroupMemberOf(filter)?.group ?? null

  const skillLocalState = useTeamShareBrowserStore((s) => s.skillLocalState)
  const skillConflicts = React.useMemo(
    () => Object.values(skillLocalState).filter((s) => s.state === 'dirty' || s.state === 'stale_dirty').length,
    [skillLocalState],
  )

  // Knowledge conflicts happen in the background — the daemon syncs on a timer
  // whether or not this column is open — so the dot is how a member finds out
  // that a document of theirs was overwritten and is waiting on a decision.
  // Documents, not sidecars: one note that conflicted twice is still one
  // decision to go and make, and that is what the label says.
  const conflictsBySyncKey = useTeamConflictsStore((s) => s.bySyncKey)
  const knowledgeConflicts = React.useMemo(
    () => Object.keys(conflictsBySyncKey).length,
    [conflictsBySyncKey],
  )
  const loadConflicts = useTeamConflictsStore((s) => s.load)
  const conflictTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  React.useEffect(() => {
    if (!conflictTeamId) return
    void loadConflicts()
    // The dot exists to announce conflicts created while the user is somewhere
    // else — but the only other refreshes live inside the Knowledge column,
    // which is exactly where the user is NOT. The nav is always mounted, so
    // this is where "check again" belongs: coming back to the window, and any
    // sync finishing anywhere in the app. Both are local reads.
    const recheck = () => void loadConflicts()
    window.addEventListener('focus', recheck)
    window.addEventListener(TEAM_SYNCED_EVENT, recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      window.removeEventListener(TEAM_SYNCED_EVENT, recheck)
    }
  }, [conflictTeamId, loadConflicts])

  const attention: Record<NavGroupId, { count: number; label: string }> = {
    knowledge: {
      count: knowledgeConflicts,
      label: t('teamShare.knowledgeConflictCount', '{{count}} document needs a decision', {
        count: knowledgeConflicts,
      }),
    },
    abilities: {
      count: skillConflicts,
      label: t('teamShare.skillConflictCount', '{{count}} skill needs a decision', {
        count: skillConflicts,
      }),
    },
  }

  return (
    <>
      {(['knowledge', 'abilities'] as const).map((group) => (
        <SectionRow
          key={group}
          label={t(GROUP_DEFS[group].labelKey, GROUP_DEFS[group].fallback)}
          icon={GROUP_DEFS[group].icon}
          active={activeGroup === group}
          needsAttention={attention[group].count}
          attentionLabel={attention[group].label}
          onClick={() => select(navGroupEntryFilter(group, navGroupLast[group], { embedMode }))}
        />
      ))}
    </>
  )
}
