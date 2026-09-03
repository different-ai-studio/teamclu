import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { type TeamSkillItem, type TeamSkillDraftMetadata } from '@/stores/team-share-browser'
import { TEAM_SKILL_CATEGORIES, type TeamSkillCategory } from '@/lib/backend/cloud-api/team-skills'
import { ModalShell } from './ModalShell'

export function PublishVersionSheet({
  item,
  nextVersion,
  baseVersion,
  open,
  busy,
  changePreview,
  onLoadDraftMetadata,
  onClose,
  onSubmit,
}: {
  item: TeamSkillItem
  nextVersion: number
  /** The version this machine's copy was built from. */
  baseVersion: number | null
  open: boolean
  busy: boolean
  changePreview?: { modified: string[]; deleted: string[]; added: string[] }
  onLoadDraftMetadata: () => Promise<TeamSkillDraftMetadata>
  onClose: () => void
  onSubmit: (input: {
    changelog: string
    summary: string
    category: TeamSkillCategory
    whenToUse: string
    whenNotToUse: string
    requires: string[]
  }) => Promise<void>
}) {
  const { t } = useTranslation()
  const [changelog, setChangelog] = React.useState('')
  const [summary, setSummary] = React.useState(item.summary ?? '')
  const [category, setCategory] = React.useState<TeamSkillCategory>(
    (TEAM_SKILL_CATEGORIES.includes(item.category as TeamSkillCategory)
      ? item.category
      : 'general') as TeamSkillCategory,
  )
  const [whenToUse, setWhenToUse] = React.useState(item.whenToUse ?? '')
  const [whenNotToUse, setWhenNotToUse] = React.useState(item.whenNotToUse ?? '')
  const [requiresText, setRequiresText] = React.useState((item.requires ?? []).join(', '))
  const [metadataLoading, setMetadataLoading] = React.useState(false)
  const [metadataReady, setMetadataReady] = React.useState(false)
  const [metadataError, setMetadataError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setChangelog('')
    setSummary(item.summary ?? '')
    setCategory(
      (TEAM_SKILL_CATEGORIES.includes(item.category as TeamSkillCategory)
        ? item.category
        : 'general') as TeamSkillCategory,
    )
    setWhenToUse(item.whenToUse ?? '')
    setWhenNotToUse(item.whenNotToUse ?? '')
    setRequiresText((item.requires ?? []).join(', '))
    setMetadataLoading(true)
    setMetadataReady(false)
    setMetadataError(null)
    void onLoadDraftMetadata()
      .then((draft) => {
        if (typeof draft.summary === 'string') setSummary(draft.summary)
        if (
          typeof draft.category === 'string' &&
          TEAM_SKILL_CATEGORIES.includes(draft.category as TeamSkillCategory)
        ) {
          setCategory(draft.category as TeamSkillCategory)
        }
        if (typeof draft.whenToUse === 'string') setWhenToUse(draft.whenToUse)
        if (typeof draft.whenNotToUse === 'string') setWhenNotToUse(draft.whenNotToUse)
        if (draft.requires !== undefined) setRequiresText((draft.requires ?? []).join(', '))
        setMetadataReady(true)
      })
      .catch((e) => {
        setMetadataError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setMetadataLoading(false))
  }, [open, item, onLoadDraftMetadata])

  if (!open) return null

  const field = 'w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60'
  const label = 'text-[11px] font-semibold uppercase tracking-wide text-faint'
  const metaHint = (draftValue: string, registryValue: string | null | undefined) =>
    draftValue.trim() !== (registryValue ?? '').trim() ? (
      <span className="ml-2 font-normal normal-case text-faint">
        {t('teamShare.skillPublishDraftDiff', 'differs from registry')}
      </span>
    ) : null

  const previewCount =
    (changePreview?.modified.length ?? 0) +
    (changePreview?.deleted.length ?? 0) +
    (changePreview?.added.length ?? 0)

  // Publishing sends the directory as it stands, and this directory was built
  // from `baseVersion`. If the team moved on while auto-follow was held back by
  // the local edit, everything published in between is about to be replaced by
  // content that predates it. That is sometimes exactly right and there is no
  // merge to offer, but it must not happen silently — the diff button beside it
  // deliberately compares against the installed version, so this warning is the
  // only place the user learns those versions exist at all.
  const latest = item.latestVersion ?? 0
  const skipped = baseVersion != null && latest > baseVersion ? latest - baseVersion : 0
  // Listed individually while a person can still read them as a list; a range
  // past that, because "v2, v3, v4, …, v37" is not more informative than
  // "v2–v37" and wraps the dialog.
  const overwritten =
    skipped === 0
      ? ''
      : skipped <= 3
        ? Array.from({ length: skipped }, (_, i) => `v${(baseVersion as number) + i + 1}`).join(', ')
        : `v${(baseVersion as number) + 1}–v${latest}`

  return (
    <ModalShell
      title={t('teamShare.skillPublishTitle', 'Publish v{{v}}', { v: nextVersion })}
      hint={t(
        'teamShare.skillPublishHint',
        'Publishes what is on disk right now. Everyone on the team moves to it automatically.',
      )}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="h-8 text-[13px]">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={
              !changelog.trim() ||
              !summary.trim() ||
              busy ||
              metadataLoading ||
              !metadataReady ||
              !!metadataError
            }
            onClick={() =>
              void onSubmit({
                changelog: changelog.trim(),
                summary: summary.trim(),
                category,
                whenToUse: whenToUse.trim(),
                whenNotToUse: whenNotToUse.trim(),
                requires: requiresText
                  .split(',')
                  .map((part) => part.trim())
                  .filter(Boolean),
              })
            }
            className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {t('teamShare.skillPublishSubmit', 'Publish')}
          </Button>
        </>
      }
    >
      {skipped > 0 && (
        <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-3 py-2">
          <p className="text-[12px] font-semibold text-foreground">
            {t('teamShare.skillPublishStaleTitle', 'Your copy is based on v{{base}}', {
              base: baseVersion,
            })}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            {t(
              'teamShare.skillPublishStaleBody',
              '{{versions}} shipped after that. Publishing v{{next}} replaces them with your copy, so those changes will be gone.',
              { versions: overwritten, next: nextVersion },
            )}
          </p>
        </div>
      )}
      {previewCount > 0 && (
        <div className="rounded-[8px] border border-border-soft bg-paper/60 px-3 py-2 text-[12px] text-muted-foreground">
          {t('teamShare.skillPublishPreview', 'Publishing {{count}} local file change(s) from disk.', {
            count: previewCount,
          })}
        </div>
      )}
      {metadataLoading && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('teamShare.skillPublishLoadingDraft', 'Reading draft metadata…')}
        </div>
      )}
      {metadataError && (
        <div className="rounded-[8px] border border-border border-l-2 border-l-destructive bg-paper px-3 py-2 text-[12px] text-muted-foreground">
          {t('teamShare.skillPublishDraftMetadataFailed', 'Could not read draft metadata: {{msg}}', {
            msg: metadataError,
          })}
        </div>
      )}
      <label className="block space-y-1">
        <span className={label}>{t('teamShare.skillShareChangelog', 'Changelog')}</span>
        <textarea
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          rows={2}
          autoFocus
          placeholder={t('teamShare.skillPublishChangelogHint', 'What changed, in one line')}
          className={field}
        />
      </label>
      <label className="block space-y-1">
        <span className={label}>
          {t('teamShare.skillShareSummary', 'Summary')}
          {metaHint(summary, item.summary)}
        </span>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} className={field} />
      </label>
      <label className="block space-y-1">
        <span className={label}>
          {t('teamShare.skillShareCategory', 'Category')}
          {metaHint(category, item.category)}
        </span>
        <Select value={category} onValueChange={(v) => setCategory(v as TeamSkillCategory)}>
          <SelectTrigger className="h-auto w-full rounded-[8px] border-border bg-background px-3 py-2 text-[13px] shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEAM_SKILL_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c} className="text-[13px]">
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="block space-y-1">
        <span className={label}>
          {t('teamShare.skillWhenToUse', 'When to use')}
          {metaHint(whenToUse, item.whenToUse)}
        </span>
        <textarea value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} rows={3} className={field} />
      </label>
      <label className="block space-y-1">
        <span className={label}>
          {t('teamShare.skillWhenNotToUse', 'When not to use')}
          {metaHint(whenNotToUse, item.whenNotToUse)}
        </span>
        <textarea
          value={whenNotToUse}
          onChange={(e) => setWhenNotToUse(e.target.value)}
          rows={3}
          className={field}
        />
      </label>
      <label className="block space-y-1">
        <span className={label}>
          {t('teamShare.skillRequires', 'Requires')}
          {metaHint(requiresText, (item.requires ?? []).join(', '))}
        </span>
        <input
          value={requiresText}
          onChange={(e) => setRequiresText(e.target.value)}
          placeholder={t('teamShare.skillRequiresHint', 'comma-separated, e.g. git, jq')}
          className={field}
        />
      </label>
    </ModalShell>
  )
}
