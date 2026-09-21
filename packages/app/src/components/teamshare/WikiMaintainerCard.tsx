import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTeamPermissions } from '@/lib/team/team-permissions'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWikiMaintainerStore } from '@/stores/wiki-maintainer-store'
import {
  cancelWikiMaintenance,
  discoverWikiSourceDirectories,
  prepareWikiMaintenance,
  publishWikiMaintenance,
} from '@/lib/knowledge/wiki-maintainer-client'
import {
  WikiMaintainerRunSheet,
  type WikiSourceDirectory,
} from '@/components/teamshare/WikiMaintainerRunSheet'

const NO_SOURCE_DIRECTORIES: string[] = []

/**
 * One entry point for people who maintain Wiki. Pipeline names and machine
 * setup stay behind the sheet; members only see the read-only explanation.
 */
export function WikiMaintainerCard() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id)
  const { canManageTeam } = useTeamPermissions()
  const selectedByTeam = useWikiMaintainerStore((s) => s.sourceDirectoriesByTeamId)
  const selected = teamId ? (selectedByTeam[teamId] ?? NO_SOURCE_DIRECTORIES) : NO_SOURCE_DIRECTORIES
  const saveSelection = useWikiMaintainerStore((s) => s.setSourceDirectories)
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [directories, setDirectories] = React.useState<WikiSourceDirectory[]>([])
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const openMaintainer = async () => {
    if (!teamId) return
    setLoading(true)
    setLoadError(null)
    try {
      setDirectories(await discoverWikiSourceDirectories(teamId))
      setOpen(true)
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div
        className="shrink-0 border-b border-border-soft px-3 py-2.5"
        data-testid="wiki-maintainer-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground">
              {t('teamShare.wikiCardTitle', 'LLM Wiki')}
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {canManageTeam
                ? t(
                    'teamShare.wikiCardAdminHint',
                    'Choose source folders, review the result, then publish. Wiki pages stay read-only.',
                  )
                : t(
                    'teamShare.wikiCardHintOff',
                    'wiki/ is published by an owner or admin. Pages are read-only. Ask about policies in a session.',
                  )}
            </p>
          </div>
          {canManageTeam && (
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0"
              disabled={!teamId || loading}
              onClick={() => void openMaintainer()}
            >
              {loading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('teamShare.wikiMaintainAction', 'Maintain Wiki')}
            </Button>
          )}
        </div>
        {loadError && <p className="mt-2 text-[11.5px] text-destructive">{loadError}</p>}
      </div>
      {teamId && (
        <WikiMaintainerRunSheet
          open={open}
          teamId={teamId}
          sourceDirectories={directories}
          initialSelected={selected}
          onSaveSelection={saveSelection}
          onPrepare={prepareWikiMaintenance}
          onPublish={publishWikiMaintenance}
          onCancel={cancelWikiMaintenance}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
