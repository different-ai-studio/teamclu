import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  Loader2,
  MessageSquare,
  Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SidebarCollapseToggle } from '@/components/app-sidebar'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useSidebar } from '@/components/ui/sidebar'
import { AppDeployFooter } from '@/components/apps/AppDeployFooter'
import { useUIStore } from '@/stores/ui'
import { useAppsStore } from '@/stores/apps-store'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { getBackend } from '@/lib/backend'
import { createAppSessionShell, openAppSession } from '@/lib/app-session'
import { formatRelativeTime } from '@/lib/date-format'
import type { AppRow, AppSessionRow } from '@/lib/backend/types'

function SessionRow({
  session,
  active,
  onClick,
}: {
  session: AppSessionRow
  active: boolean
  onClick: () => void
}) {
  const when = session.lastMessageAt ?? session.createdAt
  const rel = when ? formatRelativeTime(new Date(when)) : ''

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 border-l-2 border-transparent py-2.5 pl-4 pr-4 text-left transition-colors hover:bg-selected/40',
        active && 'border-coral bg-paper',
      )}
    >
      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-semibold text-foreground">{session.title}</span>
        {rel && (
          <span className="font-mono text-[11px] text-faint">{rel}</span>
        )}
      </span>
    </button>
  )
}

export function AppSessionsColumn() {
  const { t } = useTranslation()
  const { state: sidebarState } = useSidebar()
  const sidebarCollapsed = sidebarState === 'collapsed'

  const selectedAppId = useAppsStore((s) => s.selectedAppId)
  const items = useAppsStore((s) => s.items)
  const app = React.useMemo(
    () => (selectedAppId ? items.find((a) => a.id === selectedAppId) ?? null : null),
    [items, selectedAppId],
  )

  const activeSessionId = useSessionSelectionStore((s) => s.activeSessionId)
  const [sessions, setSessions] = React.useState<AppSessionRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (!app) {
      setSessions([])
      return
    }
    let cancelled = false
    setLoading(true)
    void getBackend()
      .apps.listAppSessions(app.id)
      .then((rows) => {
        if (cancelled) return
        setSessions(sortAppSessionsForDisplay(rows))
      })
      .catch((e) => {
        console.error('[AppSessionsColumn] failed to load sessions', e)
        if (!cancelled) setSessions([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [app?.id])

  const openSession = React.useCallback(
    async (targetApp: AppRow, sessionId: string) => {
      try {
        await openAppSession(targetApp, sessionId)
        useAppsStore.getState().recordAppSession(targetApp.id, sessionId)
        await useUIStore.getState().switchToSession(sessionId, { keepSidebarFilter: true })
      } catch (e) {
        console.error('[AppSessionsColumn] failed to open session', e)
      }
    },
    [],
  )

  const handleCreateSession = React.useCallback(async () => {
    if (!app || creating) return
    setCreating(true)
    try {
      const sessionId = await createAppSessionShell(app)
      if (!sessionId) return
      useAppsStore.getState().recordAppSession(app.id, sessionId)
      setSessions((prev) => [
        {
          id: sessionId,
          teamId: app.teamId,
          title: app.name,
          mode: 'collab',
          lastMessageAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ...prev,
      ])
      await useUIStore.getState().switchToSession(sessionId, { keepSidebarFilter: true })
    } catch (e) {
      console.error('[AppSessionsColumn] failed to create session', e)
    } finally {
      setCreating(false)
    }
  }, [app, creating])

  if (!app) {
    return (
      <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
          {sidebarCollapsed && (
            <div className="flex shrink-0 items-center gap-1">
              <TrafficLights />
              <SidebarCollapseToggle />
            </div>
          )}
          <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {t('apps.sessionsTitle', '应用会话')}
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
          {t('apps.selectAppHint', '在左侧选择一个应用以查看会话')}
        </div>
      </div>
    )
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
          <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {app.name}
            <span className="font-mono text-[11px] font-normal text-faint"> · {sessions.length}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void handleCreateSession()}
            disabled={creating}
            title={t('apps.newSession', '新建会话')}
            aria-label={t('apps.newSession', '新建会话')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-selected/40 hover:text-foreground disabled:opacity-40"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', 'Loading…')}
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-[13px] text-muted-foreground">
              {t('apps.noSessions', '此应用还没有会话')}
            </p>
            <button
              type="button"
              onClick={() => void handleCreateSession()}
              disabled={creating}
              className="rounded-[8px] bg-coral px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
            >
              {t('apps.newSession', '新建会话')}
            </button>
          </div>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              onClick={() => void openSession(app, session.id)}
            />
          ))
        )}
      </div>

      <AppDeployFooter app={app} />
    </div>
  )
}

/** Exported for tests — sorts like the column. */
export function sortAppSessionsForDisplay(rows: AppSessionRow[]): AppSessionRow[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.lastMessageAt ?? a.createdAt) || 0
    const tb = Date.parse(b.lastMessageAt ?? b.createdAt) || 0
    return tb - ta
  })
}
