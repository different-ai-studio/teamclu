import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { type TeamSkillVersion } from '@/lib/backend/cloud-api/team-skills'
import { formatShortDate } from './format'

export function VersionHistory({
  versions,
  loading,
  installedVersion,
  canRevert,
  reverting,
  onRevert,
}: {
  versions: TeamSkillVersion[]
  loading: boolean
  installedVersion: number | null
  canRevert: boolean
  reverting: boolean
  onRevert: (version: number) => void
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('common.loading', 'Loading…')}
      </div>
    )
  }
  if (!versions.length) return null

  const sorted = [...versions].sort((a, b) => b.version - a.version)
  const latest = sorted[0]
  const older = sorted.slice(1, 4)

  return (
    <div className="border-b border-border px-5 py-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
        {t('teamShare.skillVersions', 'Versions')}
      </h3>
      <div className="rounded-[8px] border border-border-soft bg-paper/60 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[12px] font-semibold text-foreground">
            v{latest.version}
            {installedVersion === latest.version && (
              <span className="ml-2 font-sans text-[10.5px] font-medium text-faint">
                {t('teamShare.skillInstalled', 'Installed')}
              </span>
            )}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            {formatShortDate(latest.createdAt) ?? ''}
          </span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">
          {latest.changelog || t('teamShare.skillFieldEmpty', '—')}
        </p>
        {latest.publishedFromVersion != null && (
          <p className="mt-1 font-mono text-[10.5px] text-faint">
            {t('teamShare.skillPublishedFrom', 'Based on v{{v}}', { v: latest.publishedFromVersion })}
          </p>
        )}
      </div>
      {older.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {older.map((v) => (
            <li key={v.version} className="flex items-baseline gap-2 text-[11.5px] text-muted-foreground">
              <span className="shrink-0 font-mono text-faint">v{v.version}</span>
              <span className="min-w-0 flex-1 truncate">
                {v.changelog || t('teamShare.skillFieldEmpty', '—')}
              </span>
              {/*
                The undo for a bad publish. Under auto-follow a broken version
                is on every member's disk within one tick, so "publish a fix"
                is not a remedy the author can always reach for — they may not
                have the old bytes any more. This re-publishes them.
              */}
              {canRevert && (
                <button
                  type="button"
                  disabled={reverting}
                  onClick={() => onRevert(v.version)}
                  className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
                >
                  {t('teamShare.skillRevertTo', 'Restore')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
