import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { type TeamSkillFileDiff } from '@/stores/team-share-browser'
import { ModalShell } from './ModalShell'

const DiffRenderer = lazy(() =>
  import('@/components/diff/DiffRenderer').then((m) => ({ default: m.DiffRenderer })),
)

export function DiffSheet({
  slug,
  diffs,
  teamDiffs,
  loading,
  teamLoading,
  showTeamTab,
  diffTab,
  onDiffTabChange,
  isDark,
  onClose,
}: {
  slug: string
  diffs: TeamSkillFileDiff[] | null
  teamDiffs: TeamSkillFileDiff[] | null
  loading: boolean
  teamLoading: boolean
  showTeamTab: boolean
  diffTab: 'local' | 'team'
  onDiffTabChange: (tab: 'local' | 'team') => void
  isDark: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const activeDiffs = diffTab === 'team' ? teamDiffs : diffs
  const activeLoading = diffTab === 'team' ? teamLoading : loading
  return (
    <ModalShell
      wide
      title={t('teamShare.skillDiffTitle', 'Your changes to {{slug}}', { slug })}
      hint={
        diffTab === 'team'
          ? t('teamShare.skillTeamDiffHint', 'What the team shipped while your draft was based on an older version.')
          : t(
              'teamShare.skillDiffHint',
              'Compared against the version you installed, not the newest one.',
            )
      }
      onClose={onClose}
      footer={
        <Button type="button" variant="ghost" onClick={onClose} className="h-8 text-[13px]">
          {t('common.close', 'Close')}
        </Button>
      }
    >
      {showTeamTab && (
        <div className="mb-3 flex gap-2">
          <button
            type="button"
            onClick={() => onDiffTabChange('local')}
            className={cn(
              'rounded-[7px] px-2.5 py-1 text-[12px]',
              diffTab === 'local'
                ? 'bg-selected text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('teamShare.skillDiffTabLocal', 'Your edits')}
          </button>
          <button
            type="button"
            onClick={() => onDiffTabChange('team')}
            className={cn(
              'rounded-[7px] px-2.5 py-1 text-[12px]',
              diffTab === 'team'
                ? 'bg-selected text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('teamShare.skillDiffTabTeam', 'Team updates')}
          </button>
        </div>
      )}
      {activeLoading && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common.loading', 'Loading…')}
        </div>
      )}
      {!activeLoading && activeDiffs?.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t('teamShare.skillDiffEmpty', 'Nothing to compare.')}
        </p>
      )}
      {!activeLoading &&
        activeDiffs?.map((d) => (
          <div key={d.path} className="space-y-1">
            <div className="font-mono text-[11px] text-faint">{d.path}</div>
            {d.binary ? (
              <p className="text-[12px] text-muted-foreground">
                {t('teamShare.skillDiffBinary', 'Binary file — not shown.')}
              </p>
            ) : (
              <Suspense
                fallback={
                  <div className="text-[12px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>
                }
              >
                <DiffRenderer
                  before={d.baseline ?? ''}
                  after={d.current ?? ''}
                  filePath={d.path}
                  isDark={isDark}
                />
              </Suspense>
            )}
          </div>
        ))}
    </ModalShell>
  )
}
