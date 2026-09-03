import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { type TeamSkillItem } from '@/stores/team-share-browser'
import { TEAM_SKILL_CATEGORIES, type TeamSkillCategory } from '@/lib/backend/cloud-api/team-skills'

export function ShareSheet({
  item,
  open,
  onClose,
  onSubmit,
  busy,
  takenSlugs,
}: {
  item: TeamSkillItem
  open: boolean
  onClose: () => void
  onSubmit: (input: {
    slug: string
    summary: string
    category: TeamSkillCategory
    whenToUse: string
    whenNotToUse: string
    changelog: string
  }) => Promise<void>
  busy: boolean
  /** Names the team registry already owns. */
  takenSlugs: ReadonlySet<string>
}) {
  const { t } = useTranslation()
  const [slug, setSlug] = React.useState(item.slug)
  const [summary, setSummary] = React.useState(item.summary ?? '')
  const [category, setCategory] = React.useState<TeamSkillCategory>(
    (TEAM_SKILL_CATEGORIES.includes(item.category as TeamSkillCategory)
      ? item.category
      : 'general') as TeamSkillCategory,
  )
  const [whenToUse, setWhenToUse] = React.useState(item.whenToUse ?? '')
  const [whenNotToUse, setWhenNotToUse] = React.useState(item.whenNotToUse ?? '')
  const [changelog, setChangelog] = React.useState('v1: shared from personal skill')

  React.useEffect(() => {
    if (!open) return
    setSlug(item.slug)
    setSummary(item.summary ?? '')
    setCategory(
      (TEAM_SKILL_CATEGORIES.includes(item.category as TeamSkillCategory)
        ? item.category
        : 'general') as TeamSkillCategory,
    )
    setWhenToUse(item.whenToUse ?? '')
    setWhenNotToUse(item.whenNotToUse ?? '')
    setChangelog('v1: shared from personal skill')
  }, [open, item])

  if (!open) return null

  // The registry rejects a duplicate name, but only after the package has been
  // uploaded. Everything needed to know that is already in this list, so say it
  // while they are still typing.
  const slugTaken = takenSlugs.has(slug.trim())

  // Guidance fields are not gates. Requiring them mostly bought placeholder
  // text, which reads as guidance without being any — worse than a blank the
  // author can come back and fill in.
  const canSubmit = slug.trim() && !slugTaken && summary.trim() && changelog.trim() && !busy

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-border bg-paper shadow-lg"
      >
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-bold text-foreground">
            {t('teamShare.skillShareTitle', 'Share to team')}
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t(
              'teamShare.skillShareHint',
              'Publishes a copy to the team registry and installs it for you. Your personal folder stays on disk.',
            )}
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareSlug', 'Slug')}
            </span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              aria-invalid={slugTaken || undefined}
              className={cn(
                'w-full rounded-[8px] border bg-background px-3 py-2 font-mono text-[13px] outline-none',
                slugTaken ? 'border-foreground' : 'border-border focus:border-coral/60',
              )}
            />
            {slugTaken && (
              <p className="text-[12px] leading-relaxed text-foreground">
                {t(
                  'teamShare.skillShareSlugTaken',
                  'The team already has a skill called {{slug}}. Pick another name, or publish a new version of the existing one.',
                  { slug: slug.trim() },
                )}
              </p>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareSummary', 'Summary')}
            </span>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={200}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareCategory', 'Category')}
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
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillWhenToUse', 'When to use')}
            </span>
            <textarea
              value={whenToUse}
              onChange={(e) => setWhenToUse(e.target.value)}
              rows={3}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillWhenNotToUse', 'When not to use')}
            </span>
            <textarea
              value={whenNotToUse}
              onChange={(e) => setWhenNotToUse(e.target.value)}
              rows={3}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t('teamShare.skillShareChangelog', 'Changelog')}
            </span>
            <textarea
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              rows={2}
              className="w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="h-8 text-[13px]">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              void onSubmit({
                slug: slug.trim(),
                summary: summary.trim(),
                category,
                whenToUse: whenToUse.trim(),
                whenNotToUse: whenNotToUse.trim(),
                changelog: changelog.trim(),
              })
            }
            className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
            {t('teamShare.skillShareSubmit', 'Share & install')}
          </Button>
        </div>
      </div>
    </div>
  )
}
