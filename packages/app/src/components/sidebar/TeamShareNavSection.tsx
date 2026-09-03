import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Plug, Box, Bookmark } from 'lucide-react'
import { useUIStore } from '@/stores/ui'
import { useTeamConflictsStore } from '@/stores/team-conflicts'
import { TEAM_SYNCED_EVENT } from '@/lib/config/build-config'
import { useTeamShareBrowserStore, type TeamShareSection } from '@/stores/team-share-browser'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { cn } from '@/lib/utils'
import { NAV_ROW_TRAILING_SLOT } from '@/components/sidebar/nav-row'

interface SectionDef {
  section: TeamShareSection
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  fallback: string
}

const SECTION_DEFS: Record<TeamShareSection, SectionDef> = {
  skills: { section: 'skills', icon: Sparkles, labelKey: 'teamShare.skills', fallback: 'Skills' },
  mcp: { section: 'mcp', icon: Plug, labelKey: 'teamShare.mcp', fallback: 'MCP' },
  env: { section: 'env', icon: Box, labelKey: 'teamShare.env', fallback: 'Team Env' },
  knowledge: { section: 'knowledge', icon: Bookmark, labelKey: 'teamShare.knowledge', fallback: 'Knowledge' },
}

const ALL_SECTIONS: TeamShareSection[] = ['skills', 'mcp', 'env', 'knowledge']

/**
 * Loads every section's count once. Split out of the rows because the nav now
 * renders team-share entries in two places (default group + 高级 group) and the
 * counts must still be fetched exactly once per team/workspace.
 *
 * Not gated on a workspace. Team-share content is the team's: skills and MCP
 * come from the registry (plus the selected Agent over RPC), knowledge from the
 * team's own directory under the amuxd home. The old `!workspacePath` guard
 * meant a client with no folder open showed 0 for all four, and the sections
 * behind them looked empty rather than unloaded.
 *
 * `workspacePath` stays in the deps: opening a folder adds this machine's local
 * rows (personal skills / MCP), so the counts have to be read again.
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
  count: number
  /** Items in this section that have stopped and need a decision. */
  needsAttention?: number
  attentionLabel?: string
  onClick: () => void
}

function SectionRow({
  label,
  icon: Icon,
  active,
  count,
  needsAttention = 0,
  attentionLabel,
  onClick,
}: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-left text-[13px] transition-[background-color,box-shadow,color] duration-150',
        active
          ? 'bg-paper font-semibold text-foreground shadow-[0_1px_2px_rgba(28,27,25,0.04)] ring-1 ring-black/[0.05]'
          : 'text-ink-2 hover:bg-black/[0.04]',
      )}
    >
      <Icon className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/*
        The one thing in this panel that reaches out. Auto-follow means a member
        may never open the skills section, so a paused update has no other way
        to be noticed — a full-ink dot against a faint count is enough contrast
        to register without spending the brand accent on it.
      */}
      {needsAttention > 0 && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
          aria-label={attentionLabel}
          title={attentionLabel}
        />
      )}
      {/* Same box as the Sessions badge / Contacts "+" — see NAV_ROW_TRAILING_SLOT. */}
      <span className={cn(NAV_ROW_TRAILING_SLOT, 'text-[10.5px] tabular-nums text-faint')}>{count}</span>
    </button>
  )
}

export function TeamShareNavSection({ sections = ALL_SECTIONS }: { sections?: TeamShareSection[] }) {
  const { t } = useTranslation()
  const filter = useUIStore((s) => s.sidebarFilter)
  const setFilter = useUIStore((s) => s.setSidebarFilter)

  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const skillsCount = useTeamShareBrowserStore((s) => s.skills.items.length)
  const mcpCount = useTeamShareBrowserStore((s) => s.mcp.items.length)
  const envCount = useTeamShareBrowserStore((s) => s.envCount)
  const knowledgeCount = useTeamShareBrowserStore((s) => s.knowledge.items.length)
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

  const counts: Record<TeamShareSection, number> = {
    skills: skillsCount,
    mcp: mcpCount,
    env: envCount,
    knowledge: knowledgeCount,
  }

  const handleSelect = React.useCallback(
    (section: TeamShareSection) => {
      setFilter({ kind: 'teamShare', section })
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

  return (
    <>
      {sections.map((section) => SECTION_DEFS[section]).map((def) => (
        <SectionRow
          key={def.section}
          label={t(def.labelKey, def.fallback)}
          icon={def.icon}
          active={filter.kind === 'teamShare' && filter.section === def.section}
          count={counts[def.section]}
          needsAttention={
            def.section === 'skills'
              ? skillConflicts
              : def.section === 'knowledge'
                ? knowledgeConflicts
                : 0
          }
          attentionLabel={
            def.section === 'knowledge'
              ? t('teamShare.knowledgeConflictCount', '{{count}} document needs a decision', {
                  count: knowledgeConflicts,
                })
              : t('teamShare.skillConflictCount', '{{count}} skill needs a decision', {
                  count: skillConflicts,
                })
          }
          onClick={() => handleSelect(def.section)}
        />
      ))}
    </>
  )
}
