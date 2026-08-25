import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Sparkles,
  Plug,
  Box,
  Lock,
  FileText,
  Bookmark,
  Loader2,
  Check,
  ArrowUpCircle,
  Plus,
  AlertTriangle,
  FilePlus,
  FolderPlus,
  RefreshCw,
  ChevronRight,
  Store,
  Bot,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useWorkspaceStore } from '@/stores/workspace'
import { useFileChangeListener } from '@/hooks/useFileChangeListener'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getBackend } from '@/lib/backend/provider'
import {
  createNewFile,
  createNewFolder,
  revealInFinder,
} from '@/components/workspace/file-tree-operations'
import { SkillFileTree, SkillRootMenuItems } from '@/components/teamshare/SkillFileTree'
import { cn } from '@/lib/utils'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { useEnvVarsStore } from '@/stores/env-vars'
import { FileBrowser } from '@/components/workspace/FileBrowser'
import { TeamDirInitPanel } from '@/components/teamshare/TeamDirInitPanel'
import { useTeamCloudSync } from '@/hooks/use-team-cloud-sync'
import { TEAM_SYNCED_EVENT } from '@/lib/build-config'
import {
  useTeamShareBrowserStore,
  type TeamMcpKind,
  type TeamShareSection,
  type TeamSkillKind,
} from '@/stores/team-share-browser'
import { detailSelectionForSection } from '@/lib/tabs/teamshare-target'
import type { ConnectedAgentRow } from '@/lib/backend/types'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { getKnownLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { SkillScanPaths } from './SkillScanPaths'

const SECTION_META: Record<
  TeamShareSection,
  { icon: React.ComponentType<{ className?: string }>; titleKey: string; titleFallback: string }
> = {
  skills: { icon: Sparkles, titleKey: 'teamShare.skills', titleFallback: 'Skills' },
  mcp: { icon: Plug, titleKey: 'teamShare.mcp', titleFallback: 'MCP' },
  env: { icon: Box, titleKey: 'teamShare.env', titleFallback: 'Team Env' },
  knowledge: { icon: Bookmark, titleKey: 'teamShare.knowledge', titleFallback: 'Knowledge' },
}

interface RowProps {
  active: boolean
  /** Omitted by the skills list, which identifies rows by name alone. */
  icon?: React.ComponentType<{ className?: string }>
  iconTint?: string
  title: string
  titleMono?: boolean
  subtitle?: string
  meta?: string
  badge?: React.ReactNode
  statusDot?: 'ready' | 'failed' | 'idle'
  trailing?: React.ReactNode
  dimmed?: boolean
  /**
   * `undefined` keeps the plain row. `true` draws a disclosure chevron; `false`
   * reserves its width so rows without a package still line up with the ones
   * that have one.
   */
  expandable?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  onClick: () => void
}

function ItemRow({
  active,
  icon: Icon,
  iconTint,
  title,
  titleMono,
  subtitle,
  meta,
  badge,
  statusDot,
  trailing,
  dimmed,
  expandable,
  expanded,
  onToggleExpand,
  onClick,
}: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 border-l-2 py-2.5 pr-4 text-left transition-colors',
        expandable === undefined ? 'pl-4' : 'pl-1',
        active ? 'border-coral bg-selected/50' : 'border-transparent hover:bg-selected/40',
      )}
    >
      {expandable === true ? (
        // A span, not a button: nesting one interactive element inside another
        // is invalid, and the row itself already expands on click. This is the
        // precision target for collapsing without changing the selection.
        <span
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand?.()
          }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-muted hover:text-muted-foreground"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />
        </span>
      ) : expandable === false ? (
        <span className="h-5 w-5 shrink-0" />
      ) : null}
      {Icon && (
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            iconTint ?? 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="h-[15px] w-[15px]" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[13.5px] font-semibold',
              titleMono && 'font-mono text-[12.5px]',
              dimmed ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {title}
          </span>
          {badge}
        </span>
        {subtitle && (
          <span className="flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
            {statusDot && (
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  statusDot === 'ready' && 'bg-emerald-500',
                  statusDot === 'failed' && 'bg-amber-500',
                  statusDot === 'idle' && 'bg-muted-foreground/40',
                )}
              />
            )}
            <span className="truncate">{subtitle}</span>
          </span>
        )}
        {meta && <span className="truncate font-mono text-[10.5px] text-faint">{meta}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center">{trailing}</span>}
    </button>
  )
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 first:pt-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.8px] text-faint">{label}</span>
      <span className="font-mono text-[10.5px] text-faint">· {count}</span>
    </div>
  )
}

type SkillRow = {
  id: string
  kind: TeamSkillKind
  title: string
  meta?: string
  badge?: React.ReactNode
  dimmed?: boolean
  trailing?: React.ReactNode
  /**
   * Absolute path of the package directory, when there is one on disk. A team
   * skill nobody installed has no files here to show — the registry row stands
   * for something that only exists in the cloud until it is installed.
   */
  packDir?: string
}

export function TeamShareListColumn({ section }: { section: TeamShareSection }) {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const meta = SECTION_META[section]

  const detailTarget = useTeamShareBrowserStore((s) => s.detailTarget)
  const selected = detailSelectionForSection(detailTarget, section)
  const activeSkillFile = detailTarget?.kind === 'skill-file' ? detailTarget : null

  const select = useTeamShareBrowserStore((s) => s.select)
  const selectSkillFile = useTeamShareBrowserStore((s) => s.selectSkillFile)
  const closeSkillFiles = useTeamShareBrowserStore((s) => s.closeSkillFiles)
  const reconcileSkills = useTeamShareBrowserStore((s) => s.reconcileSkills)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const setCreating = useTeamShareBrowserStore((s) => s.setCreating)
  const openDetail = useTeamShareBrowserStore((s) => s.openDetail)
  const currentTeamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  // Which skill packages are showing their files, and which one is being added
  // to. View state, not persisted: it says nothing about the skill itself.
  const [expandedSkills, setExpandedSkills] = React.useState<Set<string>>(new Set())
  const [rootCreate, setRootCreate] = React.useState<{
    rowId: string
    kind: 'file' | 'folder'
  } | null>(null)
  const [treeRefreshKey, setTreeRefreshKey] = React.useState(0)

  const toggleSkillExpanded = React.useCallback((id: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const skills = useTeamShareBrowserStore((s) => s.skills)
  const subjectActorId = useTeamShareBrowserStore((s) => s.subjectActorId)
  const setSubjectActor = useTeamShareBrowserStore((s) => s.setSubjectActor)
  const presenceByActor = useActorPresenceStore((s) => s.byActorId)
  const [manageableAgents, setManageableAgents] = React.useState<ConnectedAgentRow[]>([])
  const localState = useTeamShareBrowserStore((s) => s.skillLocalState)
  const mcp = useTeamShareBrowserStore((s) => s.mcp)
  const knowledge = useTeamShareBrowserStore((s) => s.knowledge)
  const teamSecrets = useEnvVarsStore((s) => s.teamSecrets)
  const knowledgeRoot = useTeamShareBrowserStore((s) => s.knowledgeRoot)
  const personalEnv = useEnvVarsStore((s) => s.envVars)

  // Inline "name this thing" row at the top of the knowledge tree.
  const [rootCreating, setRootCreating] = React.useState<'file' | 'folder' | null>(null)
  const openExternalRoot = useWorkspaceStore((s) => s.openExternalRoot)
  const selectFile = useWorkspaceStore((s) => s.selectFile)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)

  React.useEffect(() => {
    setQuery('')
    setSearchOpen(false)
    setExpandedSkills(new Set())
    setRootCreate(null)
    void loadSection(section, { force: true, withTools: section === 'mcp' })
  }, [section, loadSection])

  // `subjectActorId` is read, not depended on: this effect WRITES it, so
  // listing it here made every auto-select re-run the effect and refetch
  // listConnectedAgents — and, through setSubjectActor, mint two more grants
  // and do two more MQTT round trips — for nothing, on every mount, team
  // switch, and skills/mcp toggle.
  React.useEffect(() => {
    if ((section !== 'skills' && section !== 'mcp') || !currentTeamId) return
    let cancelled = false
    ;(async () => {
      try {
        const rows = (await getBackend().actors.listConnectedAgents(currentTeamId)).filter(
          (row) =>
            (row.is_owner === true || row.permission_level === 'admin') &&
            row.agent_status !== 'archived',
        )
        if (cancelled) return
        setManageableAgents(rows)
        const selected = useTeamShareBrowserStore.getState().subjectActorId
        const selectedStillValid = rows.some((row) => row.id === selected)
        if (rows.length === 1 && !selectedStillValid) {
          await setSubjectActor(rows[0].id)
        } else if (!selectedStillValid && selected) {
          await setSubjectActor(null)
        }
      } catch {
        if (!cancelled) setManageableAgents([])
      }
    })()
    return () => { cancelled = true }
  }, [section, currentTeamId, setSubjectActor])

  const { available: syncAvailable, syncing, syncNow } = useTeamCloudSync()

  // One button, two phases: re-read the local catalog first for instant
  // feedback, then run the cloud sync (when team share is enabled). The
  // TEAM_SYNCED_EVENT listener below reloads the section again afterwards.
  const [refreshing, setRefreshing] = React.useState(false)
  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true)
    try {
      await loadSection(section, { force: true, withTools: section === 'mcp' })
      setTreeRefreshKey((k) => k + 1)
    } finally {
      setRefreshing(false)
    }
    if (syncAvailable) await syncNow()
  }, [section, loadSection, syncAvailable, syncNow])

  // A write inside the knowledge dir — a teammate's note arriving over sync, an
  // agent editing a document — also changes the count in this header and in the
  // nav rail. The tree refreshes itself (FileBrowser watches the same root);
  // this is the other half.
  useFileChangeListener(
    () => {
      void loadSection('knowledge', { force: true })
    },
    500,
    section === 'knowledge' && !!knowledgeRoot,
    (event) => !!knowledgeRoot && event.payload.path.startsWith(`${knowledgeRoot}/`),
  )

  // Reload after any successful cloud sync, ours or another surface's.
  React.useEffect(() => {
    const onSynced = () => {
      void loadSection(section, { force: true, withTools: section === 'mcp' })
      // A sync can replace files inside an open package, so the trees have to
      // re-read rather than keep showing what was there before it ran.
      setTreeRefreshKey((k) => k + 1)
    }
    window.addEventListener(TEAM_SYNCED_EVENT, onSynced)
    return () => window.removeEventListener(TEAM_SYNCED_EVENT, onSynced)
  }, [section, loadSection])

  const loading =
    section === 'skills'
      ? skills.loading
      : section === 'mcp'
        ? mcp.loading
        : section === 'knowledge'
          ? knowledge.loading
          : false

  const count =
    section === 'skills'
      ? skills.items.length
      : section === 'mcp'
        ? mcp.items.length
        : section === 'knowledge'
          ? knowledge.items.length
          : teamSecrets.length + personalEnv.length

  const q = query.trim().toLowerCase()

  const skillRows = React.useMemo((): SkillRow[] => {
    if (section !== 'skills') return []
    return skills.items
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          (s.summary?.toLowerCase().includes(q) ?? false),
      )
      .map((s) => {
        const metaParts: string[] = []
        if (s.kind === 'personal') {
          if (s.personalSourceLabel) metaParts.push(s.personalSourceLabel)
          if (s.category) metaParts.push(s.category)
        } else {
          if (s.category) metaParts.push(s.category)
          if (s.hasUpdate && s.installedVersion != null && s.latestVersion != null) {
            metaParts.push(`v${s.installedVersion} → v${s.latestVersion}`)
          } else if (s.latestVersion) metaParts.push(`v${s.latestVersion}`)
        }
        return {
          id: s.id,
          kind: s.kind,
          // The loader stores the parent directory in `dirPath` and the folder
          // name in `filename`; together they are the package root.
          packDir:
            s.kind !== 'team-available' && s.dirPath && s.filename
              ? `${s.dirPath}/${s.filename}`
              : undefined,
          title: s.name,
          // No icon and no summary line. Every row in this list is a skill, so
          // the icon repeated the group header without distinguishing anything,
          // and a truncated one-line summary is not enough to judge a skill by
          // — that is the detail pane's job. What is left is the name plus the
          // one line that differs per row.
          meta: metaParts.filter(Boolean).join(' · ') || undefined,
          badge: (
            <span className="flex shrink-0 items-center gap-1">
              {s.kind === 'team-installed' ? (
                <span className="rounded border border-border bg-paper px-1.5 py-0.5 text-[9.5px] font-semibold text-muted-foreground">
                  {t('teamShare.scope.team', '团队')}
                </span>
              ) : null}
              {s.status === 'deprecated' ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('teamShare.skillDeprecated', 'Deprecated')}
                </span>
              ) : null}
            </span>
          ),
          dimmed: s.status === 'deprecated',
          // Three states, and only one of them is asking for anything.
          //
          // Behind on version is a transitional state that resolves itself
          // within a reconcile tick, so it stays as quiet as "installed" —
          // rendering it as an alert would train people to ignore alerts. A
          // local edit is different: auto-follow has stopped and will not
          // restart until a human decides, so it gets full ink in a column
          // where everything else is muted. That contrast is the emphasis;
          // coral is the brand accent, not a warning colour (AGENTS.md).
          trailing:
            s.kind === 'team-installed' ? (
              localState[s.slug]?.state === 'foreign' ? (
                <AlertTriangle
                  className="h-[15px] w-[15px] text-foreground"
                  aria-label={t(
                    'teamShare.skillForeign',
                    'A skill from another source already owns this name',
                  )}
                />
              ) : localState[s.slug]?.state === 'dirty' ? (
                <AlertTriangle
                  className="h-[15px] w-[15px] text-foreground"
                  aria-label={t('teamShare.skillConflict', 'Local changes — update paused')}
                />
              ) : s.hasUpdate ? (
                <ArrowUpCircle
                  className="h-[15px] w-[15px] text-muted-foreground"
                  aria-label={t('teamShare.skillUpdating', 'Updating…')}
                />
              ) : (
                <Check
                  className="h-[15px] w-[15px] text-muted-foreground"
                  aria-label={t('teamShare.skillInstalled', 'Installed')}
                />
              )
            ) : undefined,
        }
      })
  }, [section, q, skills.items, localState, t])

  const skillGroups = React.useMemo(() => {
    return [
      {
        key: 'installed' as const,
        label: t('teamShare.skillGroupAgentInstalled', 'Agent 已安装'),
        rows: skillRows,
      },
    ].filter((g) => g.rows.length > 0 || !q)
  }, [skillRows, t, q])

  const otherRows = React.useMemo(() => {
    if (section === 'mcp') {
      // Where a server comes from is the thing worth seeing at a glance: a team
      // server is someone else's decision arriving on your machine, a personal
      // or built-in one is yours. Coral is what team-owned content already uses
      // in this column (knowledge), so provenance reads the same way twice.
      const tintFor = (kind: TeamMcpKind): string =>
        kind === 'team-installed' || kind === 'team-available'
          ? 'bg-coral/10 text-coral'
          : 'bg-muted text-muted-foreground'
      return mcp.items
        .filter((m) => !q || m.name.toLowerCase().includes(q))
        .map((m) => {
          // An uninstalled server isn't wired up, so probe state is meaningless
          // for it — show what it is instead of a misleading "Idle".
          if (!m.installed) {
            return {
              id: m.id,
              kind: m.kind,
              icon: Plug,
              iconTint: tintFor(m.kind),
              title: m.name,
              subtitle:
                m.catalog?.description ||
                t('teamShare.mcpNotInstalledSubtitle', 'Available — install to run it here'),
              statusDot: 'idle' as const,
              dimmed: true,
            }
          }
          const disabled = m.config.enabled === false
          const statusDot: 'ready' | 'failed' | 'idle' = disabled
            ? 'idle'
            : m.probeStatus === 'ready'
              ? 'ready'
              : m.probeStatus === 'failed'
                ? 'failed'
                : 'idle'
          const statusLabel = disabled
            ? t('teamShare.mcpDetail.disabled', 'Disabled')
            : m.probeStatus === 'ready'
              ? t('teamShare.mcpDetail.connected', 'Connected')
              : m.probeStatus === 'failed'
                ? t('teamShare.mcpDetail.failed', 'Needs attention')
                : t('teamShare.mcpDetail.idle', 'Idle')
          return {
            id: m.id,
            kind: m.kind,
            icon: Plug,
            iconTint: tintFor(m.kind),
            title: m.name,
            subtitle: disabled
              ? statusLabel
              : `${statusLabel} · ${t('teamShare.mcpDetail.toolCount', '{{count}} tools', { count: m.tools.length })}`,
            statusDot,
            trailing: (
              <Check
                className="h-[15px] w-[15px] text-muted-foreground"
                aria-label={t('teamShare.mcpInstalled', 'Installed')}
              />
            ),
          }
        })
    }
    if (section === 'knowledge') {
      return knowledge.items
        .filter((k) => !q || k.name.toLowerCase().includes(q) || k.relPath.toLowerCase().includes(q))
        .map((k) => {
          const dir = k.relPath.includes('/') ? k.relPath.slice(0, k.relPath.lastIndexOf('/')) : ''
          return {
            id: k.path,
            icon: FileText,
            iconTint: 'bg-coral/10 text-coral',
            title: k.name,
            subtitle: dir || t('teamShare.knowledgeRoot', 'Root'),
          }
        })
    }
    if (section === 'env') {
      // Ids carry their scope. A personal key and a team key can share a name,
      // and the detail pane has to know which one it was handed.
      const team = teamSecrets
        .filter((e) => !q || e.keyId.toLowerCase().includes(q))
        .map((e) => {
          // decrypted === false means the value is there but this machine's team
          // key will not open it. Showing it as an ordinary row would be a lie.
          const undecryptable = e.decrypted === false
          return {
            id: `team:${e.keyId}`,
            icon: undecryptable ? AlertTriangle : e.category === 'config' ? Box : Lock,
            iconTint: undecryptable
              ? 'bg-amber-500/10 text-amber-600'
              : 'bg-muted text-muted-foreground',
            title: e.keyId,
            titleMono: true,
            subtitle: undecryptable
              ? e.keyMismatch
                ? t('teamShare.envDetail.keyMismatch', 'Team key does not match — cannot decrypt')
                : t('teamShare.envDetail.noLocalKey', 'No team key on this machine — cannot decrypt')
              : e.description || e.category || t('teamShare.envDetail.secret', 'Secret'),
            badge: undecryptable ? (
              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-amber-600">
                {t('teamShare.envDetail.locked', 'Locked')}
              </span>
            ) : undefined,
          }
        })
      const personal = personalEnv
        .filter((e) => !q || e.key.toLowerCase().includes(q))
        .map((e) => ({
          id: `personal:${e.key}`,
          icon: Lock,
          iconTint: 'bg-muted text-muted-foreground',
          title: e.key,
          titleMono: true,
          subtitle: e.description || t('teamShare.envDetail.personalHint', 'Stays on this machine'),
        }))
      return [...team, ...personal]
    }
    return []
  }, [section, q, mcp.items, knowledge.items, teamSecrets, personalEnv, t])

  const installedCount = React.useMemo(
    () => skills.items.filter((s) => s.kind === 'team-installed').length,
    [skills.items],
  )
  /** Team and personal are different trust boundaries, so they get their own groups. */
  const envGroups = React.useMemo(() => {
    if (section !== 'env') return null
    const rows = otherRows as Array<{ id: string }>
    const team = rows.filter((r) => r.id.startsWith('team:'))
    const personal = rows.filter((r) => r.id.startsWith('personal:'))
    return [
      { key: 'team' as const, label: t('teamShare.scope.team', 'Team'), rows: team },
      { key: 'personal' as const, label: t('teamShare.scope.personal', 'Personal'), rows: personal },
    ].filter((g) => g.rows.length > 0 || !q)
  }, [section, otherRows, t, q])

  const mcpInstalledCount = React.useMemo(
    () => mcp.items.filter((m) => m.kind === 'team-installed').length,
    [mcp.items],
  )
  // The header reads "<installed>/<team catalog>". Built-ins are this machine's,
  // not the team's — counting them here would inflate the catalog with servers
  // the team never published.
  const mcpRegistryCount = React.useMemo(
    () => mcp.items.filter((m) => m.kind !== 'personal' && m.kind !== 'builtin').length,
    [mcp.items],
  )

  const mcpGroups = React.useMemo(() => {
    if (section !== 'mcp') return null
    const rows = otherRows as Array<{ id: string; kind?: string }>
    const available = rows.filter((r) => r.kind === 'team-available')
    const installed = rows.filter((r) => r.kind === 'team-installed')
    const personal = rows.filter((r) => r.kind === 'personal')
    const builtin = rows.filter((r) => r.kind === 'builtin')
    return [
      {
        key: 'available' as const,
        label: t('teamShare.mcpGroupAvailable', 'Team · Available'),
        rows: available,
      },
      {
        key: 'installed' as const,
        label: t('teamShare.mcpGroupInstalled', 'Team · Installed'),
        rows: installed,
      },
      {
        key: 'personal' as const,
        label: t('teamShare.mcpGroupPersonal', 'Personal'),
        rows: personal,
      },
      {
        key: 'builtin' as const,
        label: t('teamShare.mcpGroupBuiltin', 'Built-in'),
        rows: builtin,
      },
    ].filter((g) => g.rows.length > 0 || !q)
  }, [section, otherRows, t, q])
  const registryCount = React.useMemo(
    () => skills.items.filter((s) => s.kind !== 'personal').length,
    [skills.items],
  )

  // Creating at the root of the shared tree. FileTree's own create flow hangs
  // off a node's context menu, which an empty tree has none of — this is the
  // only way in when the team has no documents yet.
  async function handleRootCreate(name: string) {
    const trimmed = name.trim()
    setRootCreating(null)
    if (!trimmed || !knowledgeRoot) return
    const ok =
      rootCreating === 'folder'
        ? await createNewFolder(knowledgeRoot, trimmed)
        : await createNewFile(knowledgeRoot, trimmed)
    if (!ok) return
    // The knowledge tree is its own root in the store — re-list THAT. The
    // workspace tree has nothing to do with this column any more.
    await openExternalRoot(knowledgeRoot)
    void loadSection('knowledge', { force: true })
    if (rootCreating !== 'folder') selectFile(`${knowledgeRoot}/${trimmed}`)
  }

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        {sidebarCollapsed && (
          <div className="flex shrink-0 items-center gap-1">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <meta.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {t(meta.titleKey, meta.titleFallback)}
            <span className="font-mono text-[11px] font-normal text-faint">
              {' '}
              ·{' '}
              {section === 'skills'
              ? `${installedCount}/${registryCount}`
              : section === 'mcp'
                ? `${mcpInstalledCount}/${mcpRegistryCount}`
                : count}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {section === 'skills' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'h-7 w-7 text-muted-foreground hover:text-foreground',
                (detailTarget?.kind === 'marketplace' ||
                  detailTarget?.kind === 'marketplace-item') &&
                  'bg-selected text-foreground',
              )}
              onClick={() => openDetail({ kind: 'marketplace' })}
              title={t('teamShare.browseMarketplace', '浏览市场')}
              data-testid="teamshare-marketplace"
            >
              <Store className="h-4 w-4" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            disabled={refreshing || syncing}
            onClick={() => void handleRefresh()}
            title={
              syncAvailable
                ? t('teamShare.refreshAndSync', 'Refresh and sync with cloud')
                : t('common.refresh', 'Refresh')
            }
            data-testid="teamshare-refresh"
          >
            <RefreshCw
              className={cn('h-4 w-4', (refreshing || syncing || loading) && 'animate-spin')}
            />
          </Button>
          {section === 'knowledge' && knowledgeRoot && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  title={t('teamShare.knowledgeAdd', 'New document or folder')}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onSelect={() => setRootCreating('file')}>
                  <FilePlus className="mr-2 h-3.5 w-3.5" />
                  {t('teamShare.knowledgeNewFile', 'New document')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRootCreating('folder')}>
                  <FolderPlus className="mr-2 h-3.5 w-3.5" />
                  {t('teamShare.knowledgeNewFolder', 'New folder')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {(section === 'mcp' || section === 'env') && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setCreating(section)}
              title={
                section === 'mcp'
                  ? t('teamShare.mcpAdd', 'Add MCP server')
                  : t('teamShare.envAdd', 'Add team env key')
              }
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setSearchOpen((v) => !v)}
            title={t('common.search', 'Search')}
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {(section === 'skills' || section === 'mcp') && (
        <div className="border-b border-border px-3 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-full justify-between bg-panel px-2.5 text-[12.5px] font-medium"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {manageableAgents.find((agent) => agent.id === subjectActorId)?.display_name ||
                      t('teamShare.selectAgent', '选择 Agent')}
                  </span>
                  {subjectActorId && (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        presenceByActor[subjectActorId]?.online ? 'bg-emerald-500' : 'bg-faint',
                      )}
                    />
                  )}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[240px]">
              {manageableAgents.length === 0 ? (
                <DropdownMenuItem disabled>
                  {t('teamShare.noManageableAgents', '没有可管理的 Agent')}
                </DropdownMenuItem>
              ) : (
                manageableAgents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.id}
                    onSelect={() => void setSubjectActor(agent.id)}
                    className="flex items-center gap-2"
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        presenceByActor[agent.id]?.online ? 'bg-emerald-500' : 'bg-faint',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{agent.display_name || agent.id}</span>
                    {presenceByActor[agent.id]?.online === false ? (
                      <span className="font-mono text-[10.5px] text-faint">
                        {t('common.offline', '离线')}
                      </span>
                    ) : null}
                    {agent.id === subjectActorId && <Check className="h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {searchOpen && (
        <div className="border-b border-border px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search', 'Search')}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-coral/60"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && count === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : (section === 'skills' ? skills.error : section === 'mcp' ? mcp.error : null) ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            {section === 'skills' ? skills.error : mcp.error}
          </div>
        ) : section === 'skills' ? (
          skillRows.length === 0 ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              {subjectActorId
                ? t('teamShare.agentSkillsEmpty', '当前 Agent 没有已安装的 Skills')
                : t('teamShare.selectAgentFirst', '请先选择 Agent')}
            </div>
          ) : (
            skillGroups.map((group) => (
              <div key={group.key}>
                <GroupHeader label={group.label} count={group.rows.length} />
                {group.rows.length === 0 ? (
                  <div className="px-4 pb-2 text-[11.5px] text-faint">
                    {t('teamShare.skillGroupEmpty', 'None')}
                  </div>
                ) : (
                  group.rows.map((row) => {
                    const isExpanded = expandedSkills.has(row.id)
                    const rowNode = (
                      <ItemRow
                        active={selected === row.id && !activeSkillFile}
                        title={row.title}
                        meta={row.meta}
                        badge={row.badge}
                        trailing={row.trailing}
                        dimmed={row.dimmed}
                        expandable={Boolean(row.packDir)}
                        expanded={isExpanded}
                        onToggleExpand={() => toggleSkillExpanded(row.id)}
                        onClick={() => {
                          const wasSelected = selected === row.id && !activeSkillFile
                          select(section, row.id)
                          if (!row.packDir) return
                          // Opening a skill opens its folder. Clicking the row
                          // it is already on collapses it again, so the folder
                          // can be closed without reaching for the chevron.
                          setExpandedSkills((prev) => {
                            const next = new Set(prev)
                            if (wasSelected && next.has(row.id)) next.delete(row.id)
                            else next.add(row.id)
                            return next
                          })
                        }}
                      />
                    )
                    return (
                      <div key={`${row.kind}-${row.id}`}>
                        {row.packDir ? (
                          <ContextMenu>
                            {/* The trigger needs an element that takes a ref
                                and an onContextMenu handler; ItemRow is a
                                plain component that would swallow both. */}
                            <ContextMenuTrigger asChild>
                              <div>{rowNode}</div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-48">
                              <SkillRootMenuItems
                                onNewFile={() => {
                                  setExpandedSkills((prev) => new Set(prev).add(row.id))
                                  setRootCreate({ rowId: row.id, kind: 'file' })
                                }}
                                onNewFolder={() => {
                                  setExpandedSkills((prev) => new Set(prev).add(row.id))
                                  setRootCreate({ rowId: row.id, kind: 'folder' })
                                }}
                                onReveal={() => void revealInFinder(row.packDir!)}
                              />
                            </ContextMenuContent>
                          </ContextMenu>
                        ) : (
                          rowNode
                        )}
                        {row.packDir && isExpanded && (
                          <SkillFileTree
                            packDir={row.packDir}
                            selectedRel={
                              activeSkillFile?.id === row.id ? activeSkillFile.rel : null
                            }
                            onSelectFile={(rel) => selectSkillFile(row.id, rel)}
                            onFileRemoved={(rel) => closeSkillFiles(row.id, rel)}
                            onMutated={() => {
                              void loadSection('skills', { force: true })
                              void reconcileSkills().catch(() => {})
                            }}
                            refreshKey={treeRefreshKey}
                            rootCreate={rootCreate?.rowId === row.id ? rootCreate.kind : null}
                            onRootCreateDone={() => setRootCreate(null)}
                          />
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            ))
          )
        ) : section === 'knowledge' ? (
          knowledgeRoot ? (
            // The whole shared root, not just knowledge/ — create / rename /
            // delete / move all come from FileBrowser's existing context menu,
            // and clicking a file opens it exactly as it does in the workspace.
            <FileBrowser
              variant="panel"
              rootPath={knowledgeRoot}
              hideFileActions={false}
              hideToolbar
              filterText={query}
              onFilterTextChange={setQuery}
              rootCreating={rootCreating}
              onRootCreateCancel={() => setRootCreating(null)}
              onRootCreateConfirm={(name) => {
                void handleRootCreate(name)
              }}
            />
          ) : (
            // The directory is missing locally. Sync is on regardless — this is
            // a repairable local state, so offer the repair.
            <TeamDirInitPanel />
          )
        ) : mcpGroups ? (
          mcpGroups.every((g) => g.rows.length === 0) ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              {t('teamShare.mcpEmpty', 'No MCP servers yet.')}
            </div>
          ) : (
            mcpGroups.map((group) => (
              <div key={group.key}>
                <GroupHeader label={group.label} count={group.rows.length} />
                {group.rows.length === 0 ? (
                  <div className="px-4 pb-2 text-[11.5px] text-faint">
                    {t('teamShare.skillGroupEmpty', 'None')}
                  </div>
                ) : (
                  (group.rows as typeof otherRows).map((row) => (
                    <ItemRow
                      key={row.id}
                      active={selected === row.id}
                      icon={row.icon}
                      iconTint={row.iconTint}
                      title={row.title}
                      subtitle={row.subtitle}
                      statusDot={
                        'statusDot' in row
                          ? (row.statusDot as 'ready' | 'failed' | 'idle' | undefined)
                          : undefined
                      }
                      trailing={'trailing' in row ? (row.trailing as React.ReactNode) : undefined}
                      dimmed={'dimmed' in row ? Boolean(row.dimmed) : false}
                      onClick={() => select(section, row.id)}
                    />
                  ))
                )}
              </div>
            ))
          )
        ) : envGroups ? (
          envGroups.every((g) => g.rows.length === 0) ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              {t('teamShare.envEmpty', 'No environment variables yet.')}
            </div>
          ) : (
            envGroups.map((group) => (
              <div key={group.key}>
                <GroupHeader label={group.label} count={group.rows.length} />
                {group.rows.length === 0 ? (
                  <div className="px-4 pb-2 text-[11.5px] text-faint">
                    {t('teamShare.skillGroupEmpty', 'None')}
                  </div>
                ) : (
                  (group.rows as typeof otherRows).map((row) => (
                    <ItemRow
                      key={row.id}
                      active={selected === row.id}
                      icon={row.icon}
                      iconTint={row.iconTint}
                      title={row.title}
                      titleMono={'titleMono' in row ? Boolean(row.titleMono) : false}
                      subtitle={row.subtitle}
                      badge={'badge' in row ? (row.badge as React.ReactNode) : undefined}
                      onClick={() => select(section, row.id)}
                    />
                  ))
                )}
              </div>
            ))
          )
        ) : otherRows.length === 0 ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            {t('teamShare.empty', 'Nothing shared with the team yet.')}
          </div>
        ) : (
          otherRows.map((row) => (
            <ItemRow
              key={row.id}
              active={selected === row.id}
              icon={row.icon}
              iconTint={row.iconTint}
              title={row.title}
              titleMono={'titleMono' in row ? Boolean(row.titleMono) : false}
              subtitle={row.subtitle}
              statusDot={
                'statusDot' in row
                  ? (row.statusDot as 'ready' | 'failed' | 'idle' | undefined)
                  : undefined
              }
              trailing={'trailing' in row ? (row.trailing as React.ReactNode) : undefined}
              dimmed={'dimmed' in row ? Boolean(row.dimmed) : false}
              onClick={() => select(section, row.id)}
            />
          ))
        )}
      </div>

      {/* Local roots only — a remote Agent's skills live on a disk these paths
          say nothing about. */}
      {section === 'skills' && subjectActorId && subjectActorId === getKnownLocalDaemonActorId() && (
        <SkillScanPaths workspacePath={workspacePath} refreshKey={treeRefreshKey} />
      )}
    </div>
  )
}
