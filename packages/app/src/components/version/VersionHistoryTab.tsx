import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVersionHistoryStore } from '@/stores/version-history'
import { useCurrentTeamStore } from '@/stores/current-team'
import { VersionedFileList } from '@/components/version/VersionedFileList'
import { VersionList } from '@/components/version/VersionList'
import { VersionPreview } from '@/components/version/VersionPreview'
import { useShallow } from 'zustand/react/shallow'

export function VersionHistoryTab() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id)

  const {
    versionedFiles,
    fileVersions,
    selectedFile,
    selectedRef,
    loading,
    loadVersionedFiles,
    loadFileVersions,
    fetchVersionContent,
    restoreFileVersion,
    selectFile,
    selectVersion,
  } = useVersionHistoryStore(
    useShallow((s) => ({ versionedFiles: s.versionedFiles, fileVersions: s.fileVersions, selectedFile: s.selectedFile, selectedRef: s.selectedRef, loading: s.loading, loadVersionedFiles: s.loadVersionedFiles, loadFileVersions: s.loadFileVersions, fetchVersionContent: s.fetchVersionContent, restoreFileVersion: s.restoreFileVersion, selectFile: s.selectFile, selectVersion: s.selectVersion })),
  )

  const [restoring, setRestoring] = useState(false)
  const [versionContent, setVersionContent] = useState<string | null>(null)

  useEffect(() => {
    if (teamId) {
      loadVersionedFiles(teamId)
    }
  }, [teamId, loadVersionedFiles])

  const handleFileSelect = (path: string) => {
    selectFile(path)
    if (teamId) {
      loadFileVersions(teamId, path)
    }
  }

  const handleVersionSelect = (ref: string) => {
    selectVersion(ref)
  }

  // Fetch the selected version's content lazily.
  useEffect(() => {
    let cancelled = false
    if (teamId && selectedFile && selectedRef) {
      fetchVersionContent(teamId, selectedFile.path, selectedRef).then((content) => {
        if (!cancelled) setVersionContent(content)
      })
    } else {
      setVersionContent(null)
    }
    return () => {
      cancelled = true
    }
  }, [teamId, selectedFile, selectedRef, fetchVersionContent])

  const handleRestore = async () => {
    if (!teamId || !selectedFile || !selectedRef) return
    setRestoring(true)
    try {
      await restoreFileVersion(teamId, selectedFile.path, selectedRef)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Versioned file list */}
      <div className="w-[220px] shrink-0 border-r flex flex-col overflow-hidden">
        <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t('versionHistory.fileList', 'File list')}
          {loading && <span className="ml-2 text-[10px] font-normal normal-case">{t('common.loading', 'Loading...')}</span>}
        </div>
        <div className="flex-1 overflow-hidden">
          <VersionedFileList
            files={versionedFiles}
            selectedPath={selectedFile?.path ?? null}
            onSelect={handleFileSelect}
          />
        </div>
      </div>

      {/* Middle: Version list */}
      <div className="w-[200px] shrink-0 border-r flex flex-col overflow-hidden">
        <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t('versionHistory.title', 'Version history')}
        </div>
        <div className="flex-1 overflow-hidden">
          {selectedFile ? (
            <VersionList
              versions={fileVersions}
              selectedRef={selectedRef}
              onSelect={handleVersionSelect}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground px-3 text-center">
              {t('versionHistory.selectFilePrompt', 'Select a file from the left')}
            </div>
          )}
        </div>
      </div>

      {/* Right: Version preview */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <VersionPreview
          hasSelection={selectedRef !== null}
          content={versionContent}
          canRestore={selectedRef !== null}
          onRestore={handleRestore}
          restoring={restoring}
        />
      </div>
    </div>
  )
}
