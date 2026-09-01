import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { History } from 'lucide-react'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useWorkspaceStore } from '@/stores/workspace'
import { globalTeamKnowledgeShareDir, teamSyncKeyForPath } from '@/lib/team-skill-paths'
import { VersionList } from '@/components/version/VersionList'
import { VersionPreview } from '@/components/version/VersionPreview'

/**
 * Version history for one document, as its own tab.
 *
 * Drops the file list that the browse-everything view carries: the user
 * right-clicked a specific document, so asking them to pick one again would be
 * re-asking a question they already answered.
 */
export function KnowledgeVersionHistory({ path }: { path: string }) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id)
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)

  // The daemon addresses versions by sync key (`knowledge/<rel>`), never by an
  // absolute path — the tab carries the absolute one because that is what
  // identifies the document on this machine.
  const [syncRoot, setKnowledgeDir] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    globalTeamKnowledgeShareDir()
      .then((dir) => { if (!cancelled) setKnowledgeDir(dir) })
      .catch(() => { if (!cancelled) setKnowledgeDir(null) })
    return () => { cancelled = true }
  }, [])
  const syncKey = React.useMemo(
    () => teamSyncKeyForPath(path, { syncRoot, workspacePath }),
    [path, syncRoot, workspacePath],
  )

  const fileVersions = useVersionHistoryStore((s) => s.fileVersions)
  const selectedRef = useVersionHistoryStore((s) => s.selectedRef)
  const loading = useVersionHistoryStore((s) => s.loading)
  const selectFile = useVersionHistoryStore((s) => s.selectFile)
  const selectVersion = useVersionHistoryStore((s) => s.selectVersion)
  const loadFileVersions = useVersionHistoryStore((s) => s.loadFileVersions)
  const fetchVersionContent = useVersionHistoryStore((s) => s.fetchVersionContent)
  const restoreFileVersion = useVersionHistoryStore((s) => s.restoreFileVersion)

  const [versionContent, setVersionContent] = React.useState<string | null>(null)
  const [restoring, setRestoring] = React.useState(false)

  const name = path.slice(path.lastIndexOf('/') + 1)

  React.useEffect(() => {
    selectFile(path)
    if (teamId && syncKey) void loadFileVersions(teamId, syncKey)
  }, [path, syncKey, teamId, selectFile, loadFileVersions])

  React.useEffect(() => {
    let cancelled = false
    if (teamId && syncKey && selectedRef) {
      void fetchVersionContent(teamId, syncKey, selectedRef).then((content) => {
        if (!cancelled) setVersionContent(content)
      })
    } else {
      setVersionContent(null)
    }
    return () => {
      cancelled = true
    }
  }, [teamId, syncKey, selectedRef, fetchVersionContent])

  const handleRestore = React.useCallback(async () => {
    if (!teamId || !syncKey || !selectedRef) return
    setRestoring(true)
    try {
      await restoreFileVersion(teamId, syncKey, selectedRef)
    } finally {
      setRestoring(false)
    }
  }, [teamId, syncKey, selectedRef, restoreFileVersion])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
            <History className="h-3 w-3" />
            {t('versionHistory.title', 'Version history')}
          </div>
          <div className="truncate text-[15px] font-bold text-foreground">{name}</div>
        </div>
        {loading && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t('common.loading', 'Loading...')}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-[200px] shrink-0 flex-col overflow-hidden border-r border-border">
          <VersionList
            versions={fileVersions}
            selectedRef={selectedRef}
            onSelect={selectVersion}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <VersionPreview
            hasSelection={selectedRef !== null}
            content={versionContent}
            canRestore={selectedRef !== null}
            onRestore={handleRestore}
            restoring={restoring}
          />
        </div>
      </div>
    </div>
  )
}
