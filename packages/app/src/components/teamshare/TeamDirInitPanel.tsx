import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BookPlus, FolderPlus, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useWorkspaceStore } from '@/stores/workspace'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useCurrentTeamStore } from '@/stores/current-team'
import { linkDaemonTeamWorkspace, TEAM_LINK_LEGACY_DAEMON } from '@/lib/daemon/daemon-local-client'
import { scaffoldKnowledgeVault } from '@/lib/knowledge/scaffold-client'
import { isTauri } from '@/lib/utils'

export type KnowledgeInitMode = 'missing-dir' | 'empty-vault'

type Props = {
  /**
   * `missing-dir` — sync root absent on this machine; rebuild then scaffold.
   * `empty-vault` — directory exists but has no notes yet; scaffold only.
   */
  mode?: KnowledgeInitMode
  /** Called after a successful scaffold so the parent can refresh empty-state. */
  onScaffolded?: () => void
}

/**
 * One-click knowledge vault initialization.
 *
 * Two repairable empty states share this panel:
 * 1. The team's sync root is missing locally → `POST /v1/team/link`, then scaffold.
 * 2. The vault exists but has no files yet → scaffold only.
 *
 * Scaffold is idempotent (existing files are never overwritten).
 */
export function TeamDirInitPanel({ mode = 'missing-dir', onScaffolded }: Props) {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const teamName = useCurrentTeamStore((s) => s.team?.name ?? null)

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const ready = isTauri()
  const missingDir = mode === 'missing-dir'

  async function handleInit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (missingDir) {
        await linkDaemonTeamWorkspace(workspacePath, { strict: true })
        await loadSection('knowledge', { force: true })
        if (!useTeamShareBrowserStore.getState().syncRoot) {
          setError(
            t(
              'teamShare.dirMissingStillMissing',
              'Rebuilt, but the team folder is still not here. The local daemon is probably out of date — restart or update it, then try again.',
            ),
          )
          return
        }
      }

      await scaffoldKnowledgeVault({ teamName: teamName ?? undefined })
      await loadSection('knowledge', { force: true })
      onScaffolded?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(
        msg === TEAM_LINK_LEGACY_DAEMON
          ? t(
              'teamShare.dirMissingDaemonTooOld',
              'The local daemon is too old to create the team folder on its own. Restart or update it, then try again.',
            )
          : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  const title = missingDir
    ? t('teamShare.dirMissingTitle', 'Team folder is missing on this machine')
    : t('teamShare.knowledgeScaffoldTitle', '初始化团队知识库')
  const body = missingDir
    ? t(
        'teamShare.dirMissingBody',
        "Team sync is on, but the team's folder is not on this machine yet. Rebuilding creates it and pulls the team content down.",
      )
    : t(
        'teamShare.knowledgeScaffoldBody',
        '一键生成标准目录（入职、域知识、决策、运维手册等）和双语模板。已有文件不会被覆盖。',
      )
  const action = missingDir
    ? t('teamShare.dirMissingAction', 'Rebuild team folder')
    : t('teamShare.knowledgeScaffoldAction', '初始化知识库')
  const Icon = missingDir ? FolderPlus : BookPlus

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" data-testid="knowledge-init-panel">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="max-w-[280px] text-[12.5px] leading-relaxed text-muted-foreground">{body}</p>

      {ready ? (
        <Button
          size="sm"
          onClick={() => void handleInit()}
          disabled={busy}
          data-testid="knowledge-init-action"
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {action}
        </Button>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {t('teamShare.dirMissingNeedsDesktop', 'This can only be repaired from the desktop app.')}
        </p>
      )}

      {error && <p className="max-w-[280px] text-[12px] text-red-500">{error}</p>}
    </div>
  )
}
