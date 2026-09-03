import { useTranslation } from 'react-i18next'
import { Loader2, Trash2, Copy, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Shown when auto-follow has stopped because the pack was edited locally.
 *
 * This is the only place in the skills UI that asks the user for anything, so
 * it is the only place that gets emphasis. A version that is merely behind
 * resolves itself within a reconcile tick and is reported as quiet meta text —
 * treating a self-healing state as an alert is how alerts stop meaning
 * anything.
 *
 * Naming the changed files is load-bearing rather than decorative. The user's
 * first question is "did I change this?", and a list of paths answers it
 * outright; "this skill has local modifications" leaves them opening a diff to
 * find out whether they care.
 */
export function ConflictBar({
  modified,
  deleted,
  added,
  installedVersion,
  latestVersion,
  busy,
  canPublish,
  isStaleDirty,
  source,
  onViewDiff,
  onPublish,
  onFork,
  onDiscard,
  onRebaseOnLatest,
}: {
  modified: string[]
  deleted: string[]
  added: string[]
  installedVersion: number | null
  latestVersion: number | null
  busy: boolean
  canPublish: boolean
  isStaleDirty: boolean
  source: 'hosted-agent' | 'member'
  onViewDiff: () => void
  onPublish: () => void
  onFork: () => void
  onDiscard: () => void
  onRebaseOnLatest: () => void
}) {
  const { t } = useTranslation()
  const changed = [
    modified.length
      ? t('teamShare.skillConflictModified', '{{files}} changed', { files: modified.join('、') })
      : null,
    deleted.length
      ? t('teamShare.skillConflictDeleted', '{{files}} deleted', { files: deleted.join('、') })
      : null,
    added.length
      ? t('teamShare.skillConflictAdded', '{{files}} added', { files: added.join('、') })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="border-b border-border px-5 py-3">
      <div className="rounded-[8px] border border-border border-l-2 border-l-faint bg-paper px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">
            {isStaleDirty
              ? t('teamShare.skillStaleConflictTitle', 'Your draft is behind the team')
              : t('teamShare.skillConflictTitle', 'Local changes — updates paused')}
          </span>
          {latestVersion != null && installedVersion != null && (
            <span className="shrink-0 font-mono text-[11px] text-faint">
              {t('teamShare.skillConflictVersions', 'team v{{latest}} · you v{{installed}}', {
                latest: latestVersion,
                installed: installedVersion,
              })}
            </span>
          )}
        </div>
        {isStaleDirty && (
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {t(
              'teamShare.skillStaleConflictBody',
              'Your edits are based on v{{base}}. The team is on v{{latest}} — someone else may have published while you were editing. Drafts stay on this device until you publish.',
              { base: installedVersion, latest: latestVersion },
            )}
          </p>
        )}
        {changed && (
          <p className="mt-1 break-words text-[12px] leading-relaxed text-muted-foreground">{changed}</p>
        )}
        <p className="mt-1 text-[11.5px] text-faint">
          {source === 'hosted-agent'
            ? t('teamShare.skillConflictSourceHosted', '修改来源：本机 Hosted Agent')
            : t('teamShare.skillConflictSourceMember', '修改来源：本机成员目录')}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onViewDiff}
            disabled={busy}
            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
          >
            {t('teamShare.skillConflictViewDiff', 'View changes')}
          </button>
          <span className="flex-1" />
          {canPublish && !isStaleDirty && (
            <Button
              type="button"
              onClick={onPublish}
              disabled={busy}
              className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {t('teamShare.skillConflictPublish', 'Publish as v{{v}}', {
                v: (latestVersion ?? 0) + 1,
              })}
            </Button>
          )}
          {isStaleDirty && latestVersion != null && (
            <Button
              type="button"
              variant="ghost"
              onClick={onRebaseOnLatest}
              disabled={busy}
              className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              {t('teamShare.skillRebaseOnLatest', 'Apply team v{{v}}', { v: latestVersion })}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={onFork}
            disabled={busy}
            className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
            {t('teamShare.skillConflictFork', 'Save as personal')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onDiscard}
            disabled={busy}
            className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {isStaleDirty
              ? t('teamShare.skillConflictDiscardStale', 'Discard draft')
              : t('teamShare.skillConflictDiscard', 'Discard local changes')}
          </Button>
        </div>
      </div>
    </div>
  )
}
