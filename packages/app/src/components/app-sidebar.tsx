import * as React from "react"
import { useTranslation } from "react-i18next"
import { Search, SquarePen, PanelLeftIcon, Settings, ChevronUp, Mail, CalendarDays, LogOut, Users, Trophy } from "lucide-react"

import { useSessionStore } from "@/stores/session"
import { useUIStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { useCronStore } from "@/stores/cron"
import { useAuthStore } from "@/stores/auth-store"
import { useCurrentTeamStore } from "@/stores/current-team"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AnimatedClock } from "@/components/ui/animated-clock"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TrafficLights } from "@/components/ui/traffic-lights"
import { useSessionListActivityMap } from "@/hooks/use-session-list-activity-map"
import { SessionSearchDialog } from "@/components/sidebar/session-search-dialog"
import { SessionDetailDialog, type SessionDetailListHints } from "@/components/sidebar/SessionDetailDialog"
import { NavRail } from "@/components/sidebar/NavRail"
import { LocalDaemonCard } from "@/components/sidebar/LocalDaemonCard"
import { SIDEBAR_INTERACTIVE_CURSOR } from "@/components/sidebar/sidebar-interactive-cursor"
import { useMqttConnected } from "@/hooks/useMqttConnected"
import { recoverMqttConnection } from "@/stores/mqtt-reconnect"

/** Sidebar collapse control only (workspace variant sidebar header). */
export function SidebarCollapseToggle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", className)}
      onClick={toggleSidebar}
      title={t("navigation.collapseSidebar", "Collapse sidebar")}
      aria-label={t("navigation.collapseSidebar", "Collapse sidebar")}
    >
      <PanelLeftIcon className="h-4 w-4" />
    </Button>
  )
}

/** Search, scheduled-session filter, and new chat — used below quick links in workspace sidebar or in collapsed main header. */
export function SidebarSecondarySessionActions({
  className,
  includeSearchDialog = true,
  /** When true, only the new-chat control is shown (workspace shell + collapsed sidebar inset header). */
  newChatOnly = false,
  /** In sidebar: full-width rounded new-chat row; search/cron stay on a line above, right-aligned. */
  newChatVariant = "compact",
}: {
  className?: string
  /** When false, omit the dialog + global ⌘K handler (use if another instance already owns search, e.g. collapsed header vs expanded sidebar). */
  includeSearchDialog?: boolean
  newChatOnly?: boolean
  newChatVariant?: "compact" | "sidebarWide"
}) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore(s => s.workspacePath)
  const showCronSessions = useCronStore(s => s.showCronSessions)
  const toggleShowCronSessions = useCronStore(s => s.toggleShowCronSessions)
  const [searchOpen, setSearchOpen] = React.useState(false)

  const hasWorkspace = !!workspacePath
  const showSearchAndCron = !newChatOnly
  const effectiveIncludeSearchDialog = includeSearchDialog && showSearchAndCron

  React.useEffect(() => {
    if (!effectiveIncludeSearchDialog) return
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (hasWorkspace) {
          setSearchOpen((open) => !open)
        }
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [hasWorkspace, effectiveIncludeSearchDialog])

  const handleNewSession = () => {
    if (!hasWorkspace) return
    useUIStore.getState().startNewChat()
  }

  const newChatLabel = t("chat.newChat", "New Chat")
  const useWideNewChat = newChatVariant === "sidebarWide" && !newChatOnly

  /** Match sidebar surface (#fff light); border uses `secondary` (same fill as New Chat) so edge reads as that gray, not page `background`. */
  const workspaceToolbarSquareBtn =
    "h-7 w-7 shrink-0 rounded-lg border border-secondary !bg-sidebar p-0 font-normal shadow-none disabled:opacity-40 dark:!bg-sidebar"

  const searchCronRow = showSearchAndCron ? (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
        disabled={!hasWorkspace}
        onClick={() => includeSearchDialog && setSearchOpen(true)}
        title={hasWorkspace ? t('sidebar.searchWithShortcut', 'Search (⌘K)') : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
      >
        <Search className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "h-7 w-7 transition-colors disabled:opacity-40",
          showCronSessions
            ? "text-foreground bg-muted"
            : "text-muted-foreground hover:text-foreground"
        )}
        disabled={!hasWorkspace}
        onClick={toggleShowCronSessions}
        title={showCronSessions ? t('sidebar.showAllSessions', 'Show all sessions') : t('sidebar.showCronSessions', 'Show scheduled sessions')}
      >
        <AnimatedClock className="h-4 w-4" animate={showCronSessions} />
      </Button>
    </>
  ) : null

  const newChatCompactIcon = (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground disabled:opacity-40"
      onClick={handleNewSession}
      disabled={!hasWorkspace}
      title={hasWorkspace ? newChatLabel : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
    >
      <SquarePen className="h-4 w-4" />
    </Button>
  )

  return (
    <>
      {effectiveIncludeSearchDialog && (
        <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      )}
      {useWideNewChat ? (
        <div className={cn("flex w-full items-stretch gap-1.5", className)}>
          <Button
            variant="secondary"
            className="h-7 min-w-0 flex-1 justify-center gap-1.5 rounded-lg px-2.5 text-xs font-normal shadow-none disabled:opacity-40"
            onClick={handleNewSession}
            disabled={!hasWorkspace}
            title={hasWorkspace ? newChatLabel : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
          >
            <SquarePen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{newChatLabel}</span>
          </Button>
          {showSearchAndCron && (
            <>
              <Button
                variant="outline"
                className={cn(
                  workspaceToolbarSquareBtn,
                  "text-muted-foreground hover:!bg-muted/30",
                )}
                disabled={!hasWorkspace}
                onClick={() => includeSearchDialog && setSearchOpen(true)}
                title={hasWorkspace ? t('sidebar.searchWithShortcut', 'Search (⌘K)') : t('sidebar.selectWorkspaceFirst', 'Please select a workspace first')}
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                className={cn(
                  workspaceToolbarSquareBtn,
                  "hover:!bg-muted/30",
                  showCronSessions
                    ? "!bg-secondary/35 text-foreground"
                    : "text-muted-foreground",
                )}
                disabled={!hasWorkspace}
                onClick={toggleShowCronSessions}
                title={showCronSessions ? t('sidebar.showAllSessions', 'Show all sessions') : t('sidebar.showCronSessions', 'Show scheduled sessions')}
              >
                <AnimatedClock className="h-3.5 w-3.5" animate={showCronSessions} />
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className={cn("flex items-center gap-0.5", className)}>
          {searchCronRow}
          {newChatCompactIcon}
        </div>
      )}
    </>
  )
}

// Full header row: collapse + search + cron + new chat (default UI variant).
export function SidebarIconGroup({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <SidebarCollapseToggle />
      <SidebarSecondarySessionActions />
    </div>
  )
}

function SidebarUserAccountMenu() {
  const { t, i18n } = useTranslation()
  const authSession = useAuthStore((s) => s.session)
  const signOut = useAuthStore((s) => s.signOut)
  const currentTeam = useCurrentTeamStore((s) => s.team)
  const currentMember = useCurrentTeamStore((s) => s.currentMember)
  const openSettings = useUIStore((s) => s.openSettings)
  // The desktop app's *own* MQTT link. Distinct from the daemon's MQTT link,
  // which the LocalDaemonCard dot reports — see #522. Only surfaced when it is
  // known to be down; `null` (still probing) shows nothing.
  const appMqttConnected = useMqttConnected()
  const appMqttDown = appMqttConnected === false


  if (!authSession) return null

  const meta = authSession.user.userMetadata ?? undefined
  const avatarUrl = typeof meta?.avatar_url === 'string' ? meta.avatar_url : null
  const email = authSession.user.email || ""
  const fallbackName =
    (typeof meta?.full_name === 'string' && meta.full_name) ||
    (typeof meta?.name === 'string' && meta.name) ||
    (email ? email.split("@")[0] : "") ||
    t("common.user", "User")
  const userName = currentMember?.displayName || fallbackName
  const joinedAt = (() => {
    const value = currentMember?.joinedAt
    if (!value) return t("common.notAvailable", "Not available")
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return t("common.notAvailable", "Not available")
    return new Intl.DateTimeFormat(i18n?.language || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date)
  })()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 min-w-0 shrink max-w-full gap-1.5 rounded-lg px-2 text-[12px] text-ink-2 hover:bg-black/[0.04] hover:text-foreground"
          data-testid="sidebar-user-menu-trigger"
        >
          <span className="relative flex h-4 w-4 shrink-0">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
            ) : (
              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-foreground">
                {(userName?.[0] || "?").toUpperCase()}
              </div>
            )}
            {appMqttDown ? (
              <span
                role="status"
                aria-label={t('sidebar.appMqttDisconnected', 'Cannot reach the messaging server')}
                data-testid="sidebar-app-mqtt-dot"
                className="absolute -right-0.5 -top-0.5 h-[6px] w-[6px] rounded-full bg-coral ring-1 ring-paper"
              />
            ) : null}
          </span>
          <span className="min-w-0 truncate">{userName}</span>
          <ChevronUp className="h-3.5 w-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72 p-2">
        <DropdownMenuLabel className="px-2 py-1">
          <div className="truncate text-[13px] font-semibold text-foreground">{userName}</div>
          {currentMember?.role && (
            <div className="mt-0.5 font-mono text-[11px] font-normal text-muted-foreground">
              {currentMember.role}
            </div>
          )}
        </DropdownMenuLabel>
        {appMqttDown ? (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              onClick={() => {
                void recoverMqttConnection()
                openSettings('general')
              }}
              data-testid="sidebar-app-mqtt-notice"
              className="flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--coral-soft)]/40"
            >
              <span
                aria-hidden
                className="mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full bg-coral"
              />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-[12px] font-semibold text-foreground">
                  {t('sidebar.appMqttDisconnected', 'Cannot reach the messaging server')}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {t('sidebar.appMqttDisconnectedHint', 'Tap to retry or configure the server')}
                </span>
              </span>
            </button>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <div className="space-y-1 px-2 py-1.5 text-[12px]">
          <div className="flex items-start gap-2">
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-faint">{t("auth.email", "Email")}</div>
              <div className="truncate font-mono text-[11px] text-foreground">
                {email || t("common.notAvailable", "Not available")}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-faint">{t("settings.team.teamName", "Team name")}</div>
              <div className="truncate text-foreground">
                {currentTeam?.name || t("common.notAvailable", "Not available")}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-faint">{t("settings.team.joinedAt", "Joined")}</div>
              <div className="font-mono text-[11px] text-foreground">{joinedAt}</div>
            </div>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings('leaderboard')}>
          <Trophy className="mr-2 h-4 w-4" />
          {t('settings.nav.leaderboard', 'Team Leaderboard')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => { void signOut() }} variant="destructive">
          <LogOut className="mr-2 h-4 w-4" />
          {t('common.signOut', 'Sign out')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppSidebar({ className, ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()
  const activeSessionId = useSessionStore(s => s.activeSessionId)
  const sessionActivityMap = useSessionListActivityMap(activeSessionId)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  const [detailSessionId, setDetailSessionId] = React.useState<string | null>(null)
  const [detailHints, setDetailHints] = React.useState<SessionDetailListHints | null>(null)

  const openSettings = useUIStore(s => s.openSettings)

  const handleSelectSession = (id: string) => {
    useUIStore.getState().switchToSession(id)
  }

  return (
    <Sidebar variant="sidebar" className={cn(SIDEBAR_INTERACTIVE_CURSOR, className)} {...props}>
      <SessionDetailDialog
        sessionId={detailSessionId}
        teamId={teamId}
        hints={detailHints}
        activity={detailSessionId ? sessionActivityMap.get(detailSessionId) : undefined}
        activeSessionId={activeSessionId}
        onOpenChange={(open) => {
          if (!open) {
            setDetailSessionId(null)
            setDetailHints(null)
          }
        }}
        onOpenSession={handleSelectSession}
      />
      <div className="flex h-full flex-col">
        {/* Header: custom traffic lights (Tauri) or spacer + icon group */}
        <SidebarHeader
          className="flex-row items-center h-12 shrink-0 px-2 pt-0 pb-0"
          data-tauri-drag-region
        >
          <TrafficLights />
          {/* Flexible drag region */}
          <div className="flex-1" data-tauri-drag-region />
          <SidebarCollapseToggle />
        </SidebarHeader>

        <SidebarContent className="overflow-hidden">
          <NavRail />
        </SidebarContent>

        <SidebarFooter className="gap-2 px-2.5 pb-2 pt-1">
          <LocalDaemonCard />

            <div className="flex min-w-0 items-center justify-between gap-1 overflow-hidden">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 gap-1.5 rounded-lg px-2 text-[12px] text-ink-2 hover:bg-black/[0.04] hover:text-foreground"
                onClick={() => openSettings()}
              >
                <Settings className="h-3.5 w-3.5 shrink-0" />
                {t('common.settings', 'Settings')}
              </Button>
              <div className="min-w-0 overflow-hidden">
                <SidebarUserAccountMenu />
              </div>
            </div>

        </SidebarFooter>
      </div>
    </Sidebar>
  )
}
