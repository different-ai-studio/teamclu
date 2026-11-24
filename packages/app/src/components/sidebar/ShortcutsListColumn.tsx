import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Keyboard,
  Plus,
  Search,
  Settings,
} from 'lucide-react'
import { LucideIconByName } from '@/components/icons/LucideIconByName'
import { Button } from '@/components/ui/button'
import { cn, isTauri } from '@/lib/utils'
import { prepareWebHandoff } from '@/lib/shortcuts/web-handoff'
import { useShortcutsStore, buildTree, type ShortcutNode } from '@/stores/shortcuts'
import { useCurrentTeamStore } from '@/stores/current-team'
import { selectActiveTab, useTabsStore } from '@/stores/tabs'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { useUIStore } from '@/stores/ui'
import { resolveFallbackIcon } from '@/components/shortcuts/shortcut-fallback-icon'

// Icon shown when the node names no Lucide icon (and while the icon set loads).
function collectFolderIds(nodes: ShortcutNode[], out = new Set<string>()) {
  for (const node of nodes) {
    if (node.type === 'folder') out.add(node.id)
    if (node.children?.length) collectFolderIds(node.children, out)
  }
  return out
}

/**
 * The tree narrowed to `query`: a folder whose name matches keeps everything
 * under it, and a match deeper down keeps the folders on the way to it.
 * Exported for tests.
 */
export function filterShortcutTree(nodes: ShortcutNode[], query: string): ShortcutNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return nodes
  const out: ShortcutNode[] = []
  for (const node of nodes) {
    if (node.label.toLowerCase().includes(needle)) {
      out.push(node)
      continue
    }
    if (node.type === 'folder' && node.children?.length) {
      const children = filterShortcutTree(node.children, query)
      if (children.length > 0) out.push({ ...node, children })
    }
  }
  return out
}

interface ShortcutTreeRowProps {
  node: ShortcutNode
  level: number
  activeTarget: string | null
  openTargets: Set<string>
  expandedIds: Set<string>
  onToggleFolder: (id: string) => void
  onSelect: (node: ShortcutNode) => void
}

function ShortcutTreeRow({
  node,
  level,
  activeTarget,
  openTargets,
  expandedIds,
  onToggleFolder,
  onSelect,
}: ShortcutTreeRowProps) {
  const isFolder = node.type === 'folder'
  const isExpanded = expandedIds.has(node.id)
  const isActive = !!node.target && node.target === activeTarget
  const isOpen = !!node.target && openTargets.has(node.target)
  const FallbackIcon = resolveFallbackIcon(node)

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isFolder) {
            onToggleFolder(node.id)
          } else {
            onSelect(node)
          }
        }}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md py-[7px] pr-2 text-left text-[13px] transition-colors',
          isActive
            ? 'bg-paper font-semibold text-foreground'
            : 'text-ink-2 hover:bg-selected/60',
        )}
        style={{ paddingLeft: `${level * 13 + 10}px` }}
      >
        {isFolder ? (
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}
        <LucideIconByName
          name={node.icon}
          fallback={FallbackIcon}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        {isOpen && !isActive ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />
        ) : null}
      </button>
      {isFolder && isExpanded && node.children?.length ? (
        <div className="mt-0.5">
          {node.children.map((child) => (
            <ShortcutTreeRow
              key={child.id}
              node={child}
              level={level + 1}
              activeTarget={activeTarget}
              openTargets={openTargets}
              expandedIds={expandedIds}
              onToggleFolder={onToggleFolder}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SectionDivider({ label, count }: { label: string; count: number }) {
  return (
    <div className="px-4 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-faint">
      {label}
      <span className="font-mono font-normal"> · {count}</span>
    </div>
  )
}

export function ShortcutsListColumn() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'
  const personalNodes = useShortcutsStore((s) => s.personalNodes)
  const teamNodes = useShortcutsStore((s) => s.teamNodes)
  // The team's shortcuts reload whenever this column opens, quietly — that is
  // what the refresh button used to be for, and nobody needs to press it.
  const loadTeamForCurrentTeam = useShortcutsStore((s) => s.loadTeamForCurrentTeam)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  React.useEffect(() => {
    if (teamId) void loadTeamForCurrentTeam(teamId)
  }, [teamId, loadTeamForCurrentTeam])
  const [query, setQuery] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const searching = query.trim() !== ''
  const fullPersonalTree = React.useMemo(() => buildTree(personalNodes, null), [personalNodes])
  const fullTeamTree = React.useMemo(() => buildTree(teamNodes, null), [teamNodes])
  const personalTree = React.useMemo(() => filterShortcutTree(fullPersonalTree, query), [fullPersonalTree, query])
  const teamTree = React.useMemo(() => filterShortcutTree(fullTeamTree, query), [fullTeamTree, query])
  const activeTab = useTabsStore(selectActiveTab)
  const tabs = useTabsStore((s) => s.tabs)
  const openSettings = useUIStore((s) => s.openSettings)
  // Collapsed by default: a long tree opened in full buried the folder you
  // wanted under every other folder's contents. What you open stays open.
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set())
  // While searching, every folder left in the narrowed tree is open — the
  // point is to see the matches. Clearing the search gives back what you had.
  const searchExpandedIds = React.useMemo(
    () => (searching ? collectFolderIds([...personalTree, ...teamTree]) : null),
    [searching, personalTree, teamTree],
  )
  const visibleExpandedIds = searchExpandedIds ?? expandedIds

  const openTargets = React.useMemo(() => new Set(tabs.map((tab) => tab.target)), [tabs])
  const activeTarget = activeTab?.target ?? null
  const totalCount = fullPersonalTree.length + fullTeamTree.length

  const handleToggleFolder = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSelect = (node: ShortcutNode) => {
    const target = node.target
    if (!target) return
    const open = () =>
      useTabsStore.getState().openTab({
        type: node.type === 'native' ? 'native' : 'webview',
        target,
        label: node.label,
      })
    // A link to a partner web console opens signed in (lib/shortcuts/web-handoff.ts).
    if (node.type === 'link' && isTauri()) void prepareWebHandoff(target).then(open)
    else open()
  }

  const renderTree = (nodes: ShortcutNode[]) => (
    <div className="flex flex-col gap-0.5 px-2">
      {nodes.map((node) => (
        <ShortcutTreeRow
          key={node.id}
          node={node}
          level={0}
          activeTarget={activeTarget}
          openTargets={openTargets}
          expandedIds={visibleExpandedIds}
          onToggleFolder={handleToggleFolder}
          onSelect={handleSelect}
        />
      ))}
    </div>
  )

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        {sidebarCollapsed && (
          <div className="flex items-center gap-1 shrink-0">
            <TrafficLights />
            <SidebarCollapseToggle />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {t('common.shortcuts', 'Shortcuts')}
            <span className="font-mono text-[11px] font-normal text-faint"> · {totalCount}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'h-7 w-7 text-muted-foreground hover:text-foreground',
              searchOpen && 'bg-selected text-foreground',
            )}
            onClick={() => {
              setSearchOpen((open) => !open)
              setQuery('')
            }}
            title={t('common.search', 'Search')}
            aria-label={t('common.search', 'Search')}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => openSettings('shortcuts')}
            title={t('settings.shortcuts.title', 'Shortcuts')}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {searchOpen && (
        <div className="border-b border-border px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('shortcuts.searchPlaceholder', '搜索快捷方式')}
            aria-label={t('shortcuts.searchPlaceholder', '搜索快捷方式')}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-coral/60"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
        {personalTree.length > 0 ? (
          <>
            <SectionDivider label={t('shortcuts.personal', 'Personal')} count={personalTree.length} />
            {renderTree(personalTree)}
          </>
        ) : null}
        {teamTree.length > 0 ? (
          <>
            <SectionDivider label={t('shortcuts.team', 'Team')} count={teamTree.length} />
            {renderTree(teamTree)}
          </>
        ) : null}
        {searching && totalCount > 0 && personalTree.length + teamTree.length === 0 ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            {t('shortcuts.noMatch', '没有匹配的快捷方式')}
          </div>
        ) : null}
        {totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <Keyboard className="mb-2 h-7 w-7 text-faint" />
            <p className="text-[13px] font-medium text-muted-foreground">
              {t('settings.shortcuts.empty', 'No shortcuts yet')}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 h-7 gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
              onClick={() => openSettings('shortcuts')}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('settings.shortcuts.addShortcut', 'Add Shortcut')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
