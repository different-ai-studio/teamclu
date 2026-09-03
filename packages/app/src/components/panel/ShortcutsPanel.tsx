import { useState, useMemo, useCallback } from "react"
import { useTranslation } from "react-i18next"
import {
  ChevronRight,
  ChevronDown,
  Plus,
  FileText,
  ExternalLink,
  Folder,
  RefreshCw,
  Settings,
  type LucideIcon,
} from "lucide-react"
import { LucideIconByName } from "@/components/icons/LucideIconByName"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useShortcutsStore, buildTree, ShortcutNode } from "@/stores/shortcuts"
import { useTabsStore, selectActiveTab } from "@/stores/tabs"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { useCurrentTeamStore } from "@/stores/current-team"
import { useSidebar } from "@/components/ui/sidebar"

// ── Icon resolver ────────────────────────────────────────────────────
// `node.icon` is a PascalCase Lucide icon name (e.g. "ShoppingCart", "Users",
// "BarChart3"), resolved by `LucideIconByName` from a lazily loaded icon map.
// Full list: https://lucide.dev/icons
//
// Icon shown when the node names no Lucide icon (and while the icon set loads).
function resolveFallbackIcon(node: ShortcutNode): LucideIcon {
  if (node.type === "folder") return Folder
  if (node.type === "native") return FileText
  return ExternalLink
}

// ── Tree node (shadcn sidebar style) ─────────────────────────────────

interface TreeNodeProps {
  node: ShortcutNode
  level: number
  onSelect: (node: ShortcutNode) => void
  activeTarget: string | null
  openTargets: Set<string>
}

function TreeNode({ node, level, onSelect, activeTarget, openTargets }: TreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const isActive = !!(node.target && node.target === activeTarget)
  const isOpen = !!(node.target && openTargets.has(node.target))
  const isFolder = node.type === "folder"
  const FallbackIcon = resolveFallbackIcon(node)

  const handleClick = () => {
    if (isFolder) {
      setIsExpanded(!isExpanded)
    } else {
      onSelect(node)
    }
  }

  if (isFolder) {
    return (
      <div>
        <button
          onClick={handleClick}
          className={cn(
            "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
            "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
          )}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          <LucideIconByName
            name={node.icon}
            fallback={FallbackIcon}
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <span className="flex-1 truncate text-left font-medium">{node.label}</span>
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          )}
        </button>
        {isExpanded && node.children && node.children.length > 0 && (
          <div
            className="border-l border-border/60"
            style={{ marginLeft: `${level * 12 + 18}px` }}
          >
            {node.children.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                level={0}
                onSelect={onSelect}
                activeTarget={activeTarget}
                openTargets={openTargets}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        isActive
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
      )}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      <LucideIconByName
        name={node.icon}
        fallback={FallbackIcon}
        className="h-4 w-4 shrink-0 text-muted-foreground"
      />
      <span className="flex-1 truncate text-left">{node.label}</span>
      {isOpen && !isActive && (
        <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
      )}
    </button>
  )
}

// ── Section header ───────────────────────────────────────────────────

interface SectionHeaderProps {
  label: string
  onConfigure?: () => void
  onRefresh?: () => void
}

function SectionHeader({ label, onConfigure, onRefresh }: SectionHeaderProps) {
  const { t } = useTranslation()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground/70 cursor-default select-none first:pt-1">
          {label}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onRefresh && (
          <ContextMenuItem onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" />
            {t("shortcuts.refreshTeam", "Refresh Team Shortcuts")}
          </ContextMenuItem>
        )}
        {onConfigure && (
          <ContextMenuItem onClick={onConfigure}>
            <Settings className="h-3.5 w-3.5 mr-2" />
            {t("shortcuts.configurePersonal", "Configure Personal Shortcuts")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ── Main panel ───────────────────────────────────────────────────────

export function ShortcutsPanel() {
  const { t } = useTranslation()
  const loadTeamForCurrentTeam = useShortcutsStore((s) => s.loadTeamForCurrentTeam)
  const personalNodes = useShortcutsStore((s) => s.personalNodes)
  const teamNodes = useShortcutsStore((s) => s.teamNodes)
  const openSettings = useUIStore((s) => s.openSettings)
  const { setOpen: setSidebarOpen } = useSidebar()
  const isPanelOpen = useWorkspaceStore((s) => s.isPanelOpen)
  const workspaceActiveTab = useWorkspaceStore((s) => s.activeTab)
  const closePanel = useWorkspaceStore((s) => s.closePanel)
  const activeTab = useTabsStore(selectActiveTab)
  const tabs = useTabsStore((s) => s.tabs)
  const openTargets = useMemo(() => new Set(tabs.map((t) => t.target)), [tabs])
  const personalTree = useMemo(() => buildTree(personalNodes, null), [personalNodes])
  const teamTree = useMemo(() => buildTree(teamNodes, null), [teamNodes])

  const activeTarget = activeTab?.target ?? null

  /** Close workspace Shortcuts dock, expand main sidebar, then open settings (avoids header / traffic-light overlap). */
  const openPersonalShortcutsSettings = useCallback(() => {
    const inShortcutsLeftDock =
      isPanelOpen &&
      workspaceActiveTab === "shortcuts"
    if (inShortcutsLeftDock) {
      closePanel()
      setSidebarOpen(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          useUIStore.getState().openSettings("shortcuts")
        })
      })
    } else {
      openSettings("shortcuts")
    }
  }, [
    closePanel,
    isPanelOpen,
    openSettings,
    setSidebarOpen,
    workspaceActiveTab,
  ])

  const handleSelectNode = (node: ShortcutNode) => {
    if (!node.target) return
    const tabType = node.type === "native" ? "native" as const : "webview" as const
    useTabsStore.getState().openTab({
      type: tabType,
      target: node.target,
      label: node.label,
    })
  }

  const handleRefreshTeam = async () => {
    const teamId = useCurrentTeamStore.getState().team?.id ?? null
    if (teamId) await loadTeamForCurrentTeam(teamId)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-1.5">
          <SectionHeader
            label={t("shortcuts.personal", "Personal")}
            onConfigure={openPersonalShortcutsSettings}
          />
          {personalTree.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
              <Folder className="h-5 w-5 mb-1.5 opacity-20" />
              <p className="text-xs opacity-50">{t("settings.shortcuts.empty", "No shortcuts yet")}</p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-7 text-xs gap-1.5 text-muted-foreground"
                onClick={openPersonalShortcutsSettings}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("settings.shortcuts.addShortcut", "Add Shortcut")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {personalTree.map((node) => (
                <TreeNode
                  key={node.id}
                  node={node}
                  level={0}
                  onSelect={handleSelectNode}
                  activeTarget={activeTarget}
                  openTargets={openTargets}
                />
              ))}
            </div>
          )}

          {teamTree.length > 0 && (
            <>
              <SectionHeader
                label={t("shortcuts.team", "Team")}
                onConfigure={openPersonalShortcutsSettings}
                onRefresh={handleRefreshTeam}
              />
              <div className="flex flex-col gap-0.5">
                {teamTree.map((node) => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    level={0}
                    onSelect={handleSelectNode}
                    activeTarget={activeTarget}
                    openTargets={openTargets}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
