/**
 * CacheSection.tsx — Settings section for local-first cache management.
 *
 * Provides a "Refresh all data" button that clears the local cache for the
 * current team and re-pulls all tables from Supabase.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isTauri } from '@/lib/utils'
import { clearTeam } from '@/lib/cache/local-cache'
import { useSessionListStore } from '@/stores/session-list-store'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { syncActorsForTeam } from '@/lib/sync/actor-sync'
import { syncSessionsForTeam } from '@/lib/sync/session-sync'
import { syncIdeasForTeam } from '@/lib/sync/idea-sync'
import { syncMessagesForSession } from '@/lib/sync/message-sync'
import { syncParticipantsForSession } from '@/lib/sync/session-participant-sync'

export function CacheSection() {
  const { t } = useTranslation()
  const [running, setRunning] = React.useState(false)
  const [done, setDone] = React.useState(false)

  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)

  async function handleRefreshAll() {
    if (!teamId || running) return
    setRunning(true)
    setDone(false)
    try {
      // 1. Clear all local data for this team
      await clearTeam(teamId)

      // 2. Re-pull all team-scoped tables in parallel
      await Promise.all([
        syncActorsForTeam(teamId, { full: true }),
        syncSessionsForTeam(teamId, { full: true }),
        syncIdeasForTeam(teamId, { full: true }),
      ])

      // 3. Reload session list so UI reflects fresh cache
      await useSessionListStore.getState().load()

      // 4. If a session is currently open, re-pull its messages + participants
      const activeSessionId = useSessionSelectionStore.getState().currentSessionId
      if (activeSessionId) {
        await Promise.all([
          syncMessagesForSession(activeSessionId, teamId, { full: true }),
          syncParticipantsForSession(activeSessionId, teamId, { full: true }),
        ])
      }

      setDone(true)
    } catch (e) {
      console.error('[CacheSection] refresh failed:', e)
    } finally {
      setRunning(false)
    }
  }

  if (!isTauri()) return null

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold mb-1">
          {t('settings.cache.title', 'Local Cache')}
        </h2>
        <p className="text-[13px] text-muted-foreground">
          {t(
            'settings.cache.description',
            'Manage the local database that makes screens load instantly. Data is synced from the server in the background.',
          )}
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-4">
        <div className="flex items-start gap-3">
          <Database className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-[13px] font-medium">
              {t('settings.cache.refreshAll', 'Refresh all data')}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t(
                'settings.cache.refreshAllDescription',
                'Clears the local cache for this team and re-downloads everything from the server. Useful if data looks stale.',
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshAll}
            disabled={running || !teamId}
            className="gap-2"
          >
            <RotateCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
            {running
              ? t('settings.cache.refreshAllRunning', 'Refreshing…')
              : t('settings.cache.refreshAll', 'Refresh all data')}
          </Button>
          {done && !running && (
            <span className="text-xs text-green-600">
              {t('settings.cache.refreshAllDone', 'Done — cache refreshed.')}
            </span>
          )}
          {!teamId && (
            <span className="text-xs text-muted-foreground">
              {t('settings.cache.noTeam', 'No team loaded yet.')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
