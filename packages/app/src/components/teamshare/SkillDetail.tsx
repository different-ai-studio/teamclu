import * as React from 'react'
import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Sparkles,
  Save,
  Loader2,
  Download,
  Share2,
  Trash2,
  Archive,
  AlertTriangle,
  Copy,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { encodeWorkspaceId, putDaemonSkill } from '@/lib/daemon-local-client'
import {
  useTeamShareBrowserStore,
  isSkillDirtyConflict,
  SkillDiscardIncompleteError,
  SkillSlugTakenError,
  StaleTeamSkillPublishError,
  type TeamSkillItem,
  type TeamSkillFileDiff,
} from '@/stores/team-share-browser'
import { useCurrentTeamStore } from '@/stores/current-team'
import { getBackend } from '@/lib/backend/provider'
import {
  TEAM_SKILL_CATEGORIES,
  type TeamSkillCategory,
  type TeamSkillVersion,
} from '@/lib/backend/cloud-api/team-skills'
import { useIsDark } from './use-is-dark'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'
import { useActorPresenceStore } from '@/stores/actor-presence-store'
import { useEffectiveWorkspacePath } from '@/lib/effective-workspace'

type SkillConfirmAction = 'delete' | 'uninstall'

const CodeEditor = lazy(() => import('@/components/editors/CodeEditor'))
const DiffRenderer = lazy(() =>
  import('@/components/diff/DiffRenderer').then((m) => ({ default: m.DiffRenderer })),
)

/** Shared chrome for the conflict flow's dialogs. */
function ModalShell({
  title,
  hint,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  footer: React.ReactNode
  onClose: () => void
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex max-h-[85vh] w-full flex-col overflow-hidden rounded-[14px] border border-border bg-paper shadow-lg',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
      >
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-bold text-foreground">{title}</h2>
          {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      </div>
    </div>
  )
}

function UsageBoundary({ item }: { item: TeamSkillItem }) {
  const { t } = useTranslation()
  if (!item.whenToUse && !item.whenNotToUse) return null
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-border px-5 py-4 sm:grid-cols-2">
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillWhenToUse', 'When to use')}
        </h3>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {item.whenToUse || t('teamShare.skillFieldEmpty', '—')}
        </p>
      </section>
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillWhenNotToUse', 'When not to use')}
        </h3>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {item.whenNotToUse || t('teamShare.skillFieldEmpty', '—')}
        </p>
      </section>
    </div>
  )
}

function formatShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function MetaRow({ item, ownerLabel }: { item: TeamSkillItem; ownerLabel: string | null }) {
  const { t } = useTranslation()
  const primary: string[] = []
  if (item.kind === 'personal' && item.personalSourceLabel) primary.push(item.personalSourceLabel)
  if (item.category) primary.push(item.category)
  if (item.latestVersion) primary.push(`v${item.latestVersion}`)
  if (item.installed && item.installedVersion && item.installedVersion !== item.latestVersion) {
    primary.push(t('teamShare.skillInstalledVersion', 'installed v{{v}}', { v: item.installedVersion }))
  }
  if (item.requires?.length) {
    primary.push(t('teamShare.skillRequires', 'requires {{list}}', { list: item.requires.join(', ') }))
  }

  const secondary: string[] = []
  if (ownerLabel) {
    secondary.push(t('teamShare.skillOwner', 'Owner · {{name}}', { name: ownerLabel }))
  }
  const updated = formatShortDate(item.updatedAt)
  if (updated) {
    secondary.push(t('teamShare.skillUpdated', 'Updated {{date}}', { date: updated }))
  }

  if (!primary.length && !secondary.length) return null
  return (
    <div className="space-y-1 border-b border-border px-5 py-2 text-[12px] text-muted-foreground">
      {primary.length > 0 && <div>{primary.join(' · ')}</div>}
      {secondary.length > 0 && <div className="text-[11px] text-faint">{secondary.join(' · ')}</div>}
    </div>
  )
}

function VersionHistory({
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

function ShareSheet({
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
function ConflictBar({
  modified,
  deleted,
  added,
  installedVersion,
  latestVersion,
  busy,
  canPublish,
  source,
  onViewDiff,
  onPublish,
  onFork,
  onDiscard,
}: {
  modified: string[]
  deleted: string[]
  added: string[]
  installedVersion: number | null
  latestVersion: number | null
  busy: boolean
  canPublish: boolean
  source: 'hosted-agent' | 'member'
  onViewDiff: () => void
  onPublish: () => void
  onFork: () => void
  onDiscard: () => void
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
            {t('teamShare.skillConflictTitle', 'Local changes — updates paused')}
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
          {canPublish && (
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
            {t('teamShare.skillConflictDiscard', 'Discard local changes')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function PublishVersionSheet({
  item,
  nextVersion,
  baseVersion,
  open,
  busy,
  onClose,
  onSubmit,
}: {
  item: TeamSkillItem
  nextVersion: number
  /** The version this machine's copy was built from. */
  baseVersion: number | null
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (input: {
    changelog: string
    summary?: string
    whenToUse?: string
    whenNotToUse?: string
  }) => Promise<void>
}) {
  const { t } = useTranslation()
  const [changelog, setChangelog] = React.useState('')
  const [summary, setSummary] = React.useState(item.summary ?? '')
  const [whenToUse, setWhenToUse] = React.useState(item.whenToUse ?? '')
  const [whenNotToUse, setWhenNotToUse] = React.useState(item.whenNotToUse ?? '')

  React.useEffect(() => {
    if (!open) return
    setChangelog('')
    setSummary(item.summary ?? '')
    setWhenToUse(item.whenToUse ?? '')
    setWhenNotToUse(item.whenNotToUse ?? '')
  }, [open, item])

  if (!open) return null

  const field = 'w-full rounded-[8px] border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-coral/60'
  const label = 'text-[11px] font-semibold uppercase tracking-wide text-faint'

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
            disabled={!changelog.trim() || busy}
            onClick={() =>
              // Empty fields are omitted, not sent as "". The server rejects a
              // present-but-empty value, and it does so *after* the package has
              // already been uploaded — so a blank "when not to use" used to
              // cost an orphaned blob, no version, and an error naming a field
              // the dialog never marked as required. Omitted means "keep what
              // the registry already has", which is what a blank box reads as.
              void onSubmit({
                changelog: changelog.trim(),
                summary: summary.trim() || undefined,
                whenToUse: whenToUse.trim() || undefined,
                whenNotToUse: whenNotToUse.trim() || undefined,
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
        <span className={label}>{t('teamShare.skillShareSummary', 'Summary')}</span>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} className={field} />
      </label>
      <label className="block space-y-1">
        <span className={label}>{t('teamShare.skillWhenToUse', 'When to use')}</span>
        <textarea value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} rows={3} className={field} />
      </label>
      <label className="block space-y-1">
        <span className={label}>{t('teamShare.skillWhenNotToUse', 'When not to use')}</span>
        <textarea
          value={whenNotToUse}
          onChange={(e) => setWhenNotToUse(e.target.value)}
          rows={3}
          className={field}
        />
      </label>
    </ModalShell>
  )
}

function ForkSheet({
  slug,
  open,
  busy,
  onClose,
  onSubmit,
}: {
  slug: string
  open: boolean
  busy: boolean
  onClose: () => void
  onSubmit: (newSlug: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [newSlug, setNewSlug] = React.useState(`${slug}-mine`)

  React.useEffect(() => {
    if (open) setNewSlug(`${slug}-mine`)
  }, [open, slug])

  if (!open) return null

  return (
    <ModalShell
      title={t('teamShare.skillForkTitle', 'Save as personal skill')}
      // The rename is not a preference. Local skills outrank team skills in the
      // loader, so a fork keeping the original slug would shadow the team copy
      // and silently undo the auto-follow this action exists to preserve.
      hint={t(
        'teamShare.skillForkHint',
        'Keeps your edits under a new name. The team version goes back to updating automatically.',
      )}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="h-8 text-[13px]">
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={!newSlug.trim() || newSlug.trim() === slug || busy}
            onClick={() => void onSubmit(newSlug.trim())}
            className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
            {t('teamShare.skillForkSubmit', 'Save a copy')}
          </Button>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillShareSlug', 'Slug')}
        </span>
        <input
          value={newSlug}
          onChange={(e) => setNewSlug(e.target.value)}
          autoFocus
          className="w-full rounded-[8px] border border-border bg-background px-3 py-2 font-mono text-[13px] outline-none focus:border-coral/60"
        />
      </label>
    </ModalShell>
  )
}

function DiffSheet({
  slug,
  diffs,
  loading,
  isDark,
  onClose,
}: {
  slug: string
  diffs: TeamSkillFileDiff[] | null
  loading: boolean
  isDark: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <ModalShell
      wide
      title={t('teamShare.skillDiffTitle', 'Your changes to {{slug}}', { slug })}
      hint={t(
        'teamShare.skillDiffHint',
        'Compared against the version you installed, not the newest one.',
      )}
      onClose={onClose}
      footer={
        <Button type="button" variant="ghost" onClick={onClose} className="h-8 text-[13px]">
          {t('common.close', 'Close')}
        </Button>
      }
    >
      {loading && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common.loading', 'Loading…')}
        </div>
      )}
      {!loading && diffs?.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t('teamShare.skillDiffEmpty', 'Nothing to compare.')}
        </p>
      )}
      {!loading &&
        diffs?.map((d) => (
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

export function SkillDetail({ slug }: { slug: string }) {
  const { t } = useTranslation()
  const isDark = useIsDark()
  const workspacePath = useEffectiveWorkspacePath()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  // By id, not slug: a personal skill colliding with a registry name carries
  // `personal:<slug>`, and matching on slug would resolve both rows to the
  // registry one.
  const item = useTeamShareBrowserStore(
    (s) => s.skills.items.find((x) => x.id === slug) ?? s.skills.items.find((x) => x.slug === slug),
  )
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const installSkill = useTeamShareBrowserStore((s) => s.installSkill)
  const uninstallSkill = useTeamShareBrowserStore((s) => s.uninstallSkill)
  const deletePersonalSkill = useTeamShareBrowserStore((s) => s.deletePersonalSkill)
  const publishSkillVersion = useTeamShareBrowserStore((s) => s.publishSkillVersion)
  const discardLocalSkill = useTeamShareBrowserStore((s) => s.discardLocalSkill)
  const restoreDiscardedSkill = useTeamShareBrowserStore((s) => s.restoreDiscardedSkill)
  const sharePersonalSkill = useTeamShareBrowserStore((s) => s.sharePersonalSkill)
  const allSkills = useTeamShareBrowserStore((s) => s.skills.items)
  const forkSkill = useTeamShareBrowserStore((s) => s.forkSkill)
  const loadSkillDiff = useTeamShareBrowserStore((s) => s.loadSkillDiff)
  const localState = useTeamShareBrowserStore((s) => s.skillLocalState[slug])
  // Derived, not selected: a selector returning a fresh Set re-renders on every
  // store change, since the reference is new each time it runs.
  const registrySlugs = React.useMemo(
    () => new Set(allSkills.filter((x) => x.origin === 'registry').map((x) => x.slug)),
    [allSkills],
  )
  const syncError = useTeamShareBrowserStore((s) => s.skillSyncErrors[slug])
  const archivedPath = useTeamShareBrowserStore((s) => s.skillArchived[slug])
  // Optional-chained for the same reason as TeamSkillAutoFollow: partial store
  // doubles in tests never set this field.
  const retired = useTeamShareBrowserStore((s) => s.skillRetired?.[item?.slug ?? slug])
  const dismissRetired = useTeamShareBrowserStore((s) => s.dismissRetired)
  const keepArchivedCopy = useTeamShareBrowserStore((s) => s.keepArchivedCopy)
  const dismissArchived = useTeamShareBrowserStore((s) => s.dismissArchived)
  const reconcileSkills = useTeamShareBrowserStore((s) => s.reconcileSkills)
  const revertSkillVersion = useTeamShareBrowserStore((s) => s.revertSkillVersion)
  const select = useTeamShareBrowserStore((s) => s.select)
  const openDetail = useTeamShareBrowserStore((s) => s.openDetail)
  const detachMarketplaceSkill = useTeamShareBrowserStore((s) => s.detachMarketplaceSkill)
  const subjectActorId = useTeamShareBrowserStore((s) => s.subjectActorId)
  useActorPresenceStore((s) =>
    subjectActorId ? s.byActorId[subjectActorId]?.online : undefined,
  )
  const agentOffline = subjectActorId
    ? resolveAgentDevicePresenceSync(subjectActorId) === 'offline'
    : true

  const [content, setContent] = React.useState(item?.content ?? '')
  const [saving, setSaving] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [publishOpen, setPublishOpen] = React.useState(false)
  const [forkOpen, setForkOpen] = React.useState(false)
  const [diffOpen, setDiffOpen] = React.useState(false)
  const [diffs, setDiffs] = React.useState<TeamSkillFileDiff[] | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<SkillConfirmAction | null>(null)
  const [versions, setVersions] = React.useState<TeamSkillVersion[]>([])
  const [versionsLoading, setVersionsLoading] = React.useState(false)
  const [ownerLabel, setOwnerLabel] = React.useState<string | null>(null)
  const baseline = item?.content ?? ''

  React.useEffect(() => {
    setContent(item?.content ?? '')
  }, [slug, item?.content])

  React.useEffect(() => {
    if (!item || item.origin !== 'registry' || !teamId) {
      setVersions([])
      setOwnerLabel(null)
      return
    }
    let cancelled = false
    setVersionsLoading(true)
    void (async () => {
      try {
        const detail = await getBackend().teamSkills.getTeamSkill(teamId, item.slug)
        if (cancelled) return
        setVersions(detail.versions ?? [])
        const ownerId = detail.ownerActorId || item.ownerActorId
        if (ownerId) {
          try {
            const actors = await getBackend().actors.listActorDirectory(teamId)
            const match = actors.find((a) => a.id === ownerId)
            setOwnerLabel(match?.display_name?.trim() || ownerId.slice(0, 8))
          } catch {
            setOwnerLabel(ownerId.slice(0, 8))
          }
        } else {
          setOwnerLabel(null)
        }
      } catch {
        if (!cancelled) {
          setVersions([])
          setOwnerLabel(item.ownerActorId ? item.ownerActorId.slice(0, 8) : null)
        }
      } finally {
        if (!cancelled) setVersionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item, teamId, slug])

  const dirty = content !== baseline

  const handleSave = React.useCallback(async () => {
    if (!item || !workspacePath || saving) return
    setSaving(true)
    try {
      const saved = await putDaemonSkill(encodeWorkspaceId(workspacePath), item.slug, {
        content,
        dirPath: item.dirPath,
        filename: item.filename,
      })
      if (saved === null) throw new Error('daemon rejected the update')
      await loadSection('skills', { force: true })
      // Re-check the pack against its baseline right away. Saving is what makes
      // a team pack differ from the version it was installed at, and "differs"
      // is the state the conflict bar renders — which is where the only entry
      // to publishing a new version lives. Leaving it to the next reconcile
      // tick meant the author saved, saw nothing change, found no way to share
      // the edit, and waited up to ten minutes to be told there was one.
      await reconcileSkills().catch(() => {})
    } catch (e) {
      toast.error(t('teamShare.saveFailed', 'Save failed: {{msg}}', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
    }
  }, [item, workspacePath, saving, content, loadSection, reconcileSkills, t])

  const runInstall = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      await installSkill(item.slug)
      toast.success(t('teamShare.skillInstalled', 'Installed'))
    } catch (e) {
      // The installer refuses to overwrite a pack with local edits. That is a
      // state to explain, not a failure to report — the conflict bar renders as
      // soon as the reconcile records it.
      toast.error(
        isSkillDirtyConflict(e)
          ? t('teamShare.skillConflictTitle', 'Local changes — updates paused')
          : t('teamShare.skillInstallFailed', 'Install failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, installSkill, t])

  const runUninstall = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    setConfirmAction(null)
    try {
      await uninstallSkill(item.slug)
      toast.success(t('teamShare.skillUninstalled', 'Uninstalled'))
    } catch (e) {
      toast.error(
        t('teamShare.skillUninstallFailed', 'Uninstall failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, uninstallSkill, t])

  const runDelete = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    setConfirmAction(null)
    try {
      await deletePersonalSkill(item.slug)
      toast.success(t('teamShare.skillDeleted', 'Deleted'))
    } catch (e) {
      toast.error(
        t('teamShare.skillDeleteFailed', 'Delete failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, deletePersonalSkill, t])

  const runShare = React.useCallback(
    async (input: {
      slug: string
      summary: string
      category: TeamSkillCategory
      whenToUse: string
      whenNotToUse: string
      changelog: string
    }) => {
      if (!item || busy) return
      setBusy(true)
      try {
        const retiredPath = await sharePersonalSkill(item.slug, input)
        setShareOpen(false)
        toast.success(
          retiredPath
            ? t(
                'teamShare.skillSharedAndRetired',
                'Shared. Your personal copy was set aside — the team version is the one that stays up to date.',
              )
            : t('teamShare.skillShareSuccess', 'Shared and installed'),
          retiredPath
            ? {
                duration: 30_000,
                action: {
                  label: t('teamShare.skillKeepMine', 'Keep mine'),
                  onClick: () => {
                    void restoreDiscardedSkill(retiredPath, `${input.slug}-mine`).catch((e) =>
                      toast.error(
                        t('teamShare.skillRestoreFailed', 'Restore failed: {{msg}}', {
                          msg: e instanceof Error ? e.message : String(e),
                        }),
                      ),
                    )
                  },
                },
              }
            : undefined,
        )
      } catch (e) {
        toast.error(
          e instanceof SkillSlugTakenError
            ? t(
                'teamShare.skillShareSlugTaken',
                'The team already has a skill called {{slug}}. Pick another name, or publish a new version of the existing one.',
                { slug: e.slug },
              )
            : t('teamShare.skillShareFailed', 'Share failed: {{msg}}', {
                msg: e instanceof Error ? e.message : String(e),
              }),
        )
      } finally {
        setBusy(false)
      }
    },
    [item, busy, sharePersonalSkill, t],
  )

  const runPublishVersion = React.useCallback(
    async (input: {
      changelog: string
      summary?: string
      whenToUse?: string
      whenNotToUse?: string
    }) => {
      if (!item || busy) return
      if (item.upstreamSubscribed) {
        const ok = window.confirm(
          t(
            'teamShare.marketplaceDetachOnPublish',
            '发布团队版本会断开与市场的订阅，之后市场更新不再自动同步。继续？',
          ),
        )
        if (!ok) return
      }
      setBusy(true)
      try {
        await publishSkillVersion(item.slug, input)
        setPublishOpen(false)
        toast.success(t('teamShare.skillPublished', 'Published'))
      } catch (e) {
        if (e instanceof StaleTeamSkillPublishError) {
          toast.error(
            t(
              'teamShare.skillPublishStaleBase',
              'Someone else published while you were editing. Your draft is kept — refresh and resolve the conflict.',
            ),
          )
          return
        }
        toast.error(
          t('teamShare.skillPublishFailed', 'Publish failed: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusy(false)
      }
    },
    [item, busy, publishSkillVersion, t],
  )

  const undoAction = React.useCallback(
    (trashedPath: string, slug: string) => ({
      label: t('common.undo', 'Undo'),
      onClick: () => {
        void restoreDiscardedSkill(trashedPath, slug).catch((e) =>
          toast.error(
            t('teamShare.skillRestoreFailed', 'Restore failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
          ),
        )
      },
    }),
    [restoreDiscardedSkill, t],
  )

  const runDiscard = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      const trashedPath = await discardLocalSkill(item.slug)
      // Undo instead of a confirmation dialog: the dialog taxes everyone to
      // guard against a rare misclick, while the undo guards the misclick and
      // costs the other 99% nothing. The bytes are already saved aside, so this
      // is honest rather than optimistic.
      toast.success(t('teamShare.skillDiscarded', 'Local changes discarded'), {
        action: undoAction(trashedPath, item.slug),
      })
    } catch (e) {
      // A discard that got as far as moving the edits aside still has to offer
      // the undo — that path is where the user most needs it, and it is exactly
      // where a plain error toast would leave their work stranded in a
      // directory they cannot see.
      const stranded = e instanceof SkillDiscardIncompleteError ? e : null
      toast.error(
        stranded
          ? t('teamShare.skillDiscardIncomplete', 'Local changes set aside, but the team version could not be downloaded. It will arrive on the next sync.')
          : t('teamShare.skillDiscardFailed', 'Discard failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
        stranded
          ? { duration: 30_000, action: undoAction(stranded.trashedPath, item.slug) }
          : undefined,
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, discardLocalSkill, undoAction, t])

  const runFork = React.useCallback(
    async (newSlug: string) => {
      if (!item || busy) return
      setBusy(true)
      try {
        await forkSkill(item.slug, newSlug)
        setForkOpen(false)
        toast.success(t('teamShare.skillForked', 'Saved as {{slug}}', { slug: newSlug }))
      } catch (e) {
        toast.error(
          t('teamShare.skillForkFailed', 'Save failed: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusy(false)
      }
    },
    [item, busy, forkSkill, t],
  )

  const runKeepArchived = React.useCallback(async () => {
    if (!item || busy) return
    setBusy(true)
    try {
      await keepArchivedCopy(item.slug, `${item.slug}-mine`)
      toast.success(t('teamShare.skillForked', 'Saved as {{slug}}', { slug: `${item.slug}-mine` }))
    } catch (e) {
      toast.error(
        t('teamShare.skillRestoreFailed', 'Restore failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [item, busy, keepArchivedCopy, t])

  const runRevert = React.useCallback(
    (version: number) => {
      if (!item || busy) return
      setBusy(true)
      void revertSkillVersion(item.slug, version)
        .then(() =>
          toast.success(t('teamShare.skillReverted', 'Restored v{{v}} as the current version', { v: version })),
        )
        .catch((e) =>
          toast.error(
            t('teamShare.skillRevertFailed', 'Restore failed: {{msg}}', {
              msg: e instanceof Error ? e.message : String(e),
            }),
          ),
        )
        .finally(() => setBusy(false))
    },
    [item, busy, revertSkillVersion, t],
  )

  const openDiff = React.useCallback(() => {
    if (!item) return
    setDiffOpen(true)
    setDiffLoading(true)
    setDiffs(null)
    void loadSkillDiff(item.slug)
      .then(setDiffs)
      .catch((e) => {
        setDiffs([])
        toast.error(
          t('teamShare.skillDiffFailed', 'Could not load changes: {{msg}}', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
      })
      .finally(() => setDiffLoading(false))
  }, [item, loadSkillDiff, t])

  if (!item) return null

  const conflicted =
    localState?.state === 'dirty' || localState?.state === 'stale_dirty'
  const isRegistry = item.origin === 'registry'
  const isPersonal = item.kind === 'personal'
  const isBuiltin = isPersonal && item.personalSource === 'builtin'
  // `dirPath` is only ever populated when the selected Agent is this machine
  // (see `localSkillFiles` in the store): a remote Agent's files live on another
  // disk and the RPC inventory carries neither path nor content. So these two
  // read as "this Agent is local AND the pack is here", which is exactly the
  // precondition for editing it and for packing it up to publish.
  const canEdit = Boolean(item.dirPath && item.filename && (item.kind === 'personal' || item.installed))
  const canShare = isPersonal && Boolean(item.dirPath && item.filename)
  const latestChangelog = [...versions].sort((a, b) => b.version - a.version)[0]?.changelog
  // Any team member can publish and revert: the registry is team property, and
  // the gate on a new version is the required fields, not an approver. `owner`
  // stays on the row as the answer to "who is responsible for this" — it is
  // displayed, not enforced (see the member-writes migration and the pg-repo
  // header).
  const canPublish = isRegistry
  const baseVersion = localState?.installedVersion
    ? Number(localState.installedVersion)
    : item.installedVersion

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3" data-tauri-drag-region>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
          <Sparkles className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {t('teamShare.skills', 'Skills')}
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-bold text-foreground">{item.name}</span>
            {item.marketplaceOrigin === 'marketplace' && (
              <button
                type="button"
                className="shrink-0 rounded border border-border bg-paper px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
                onClick={() =>
                  openDetail({
                    kind: 'marketplace-item',
                    slug: item.upstreamSlug || item.slug,
                  })
                }
              >
                {t('teamShare.marketplaceBadge', '市场')}
              </button>
            )}
            {item.status === 'deprecated' && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <Archive className="h-3 w-3" />
                {t('teamShare.skillDeprecated', 'Deprecated')}
              </span>
            )}
            {isPersonal && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t('teamShare.skillPersonalBadge', 'Personal')}
              </span>
            )}
          </div>
          {item.marketplaceOrigin === 'marketplace' && (
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
              <span>
                {item.upstreamSubscribed
                  ? t('teamShare.marketplaceFollowingShort', '跟随市场 v{{v}}', {
                      v: item.latestVersion,
                    })
                  : t('teamShare.marketplaceDetachedShort', '已断开 · 停在市场版本')}
              </span>
              {item.upstreamSubscribed ? (
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => {
                    void detachMarketplaceSkill(item.slug)
                      .then(() =>
                        toast.success(t('teamShare.marketplaceDetachedToast', '已断开订阅')),
                      )
                      .catch((e) =>
                        toast.error(e instanceof Error ? e.message : String(e)),
                      )
                  }}
                >
                  {t('teamShare.marketplaceDetach', '断开订阅')}
                </button>
              ) : null}
            </div>
          )}
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{item.invocationName}</span>

        {item.kind === 'team-available' && (
          <Button
            type="button"
            onClick={() => void runInstall()}
            disabled={busy || agentOffline || item.status === 'deprecated'}
            className={cn(
              'h-8 gap-1.5 text-[13px] font-semibold',
              item.status === 'deprecated'
                ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                : 'bg-coral text-white hover:bg-coral/90',
            )}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('teamShare.skillInstall', 'Install')}
          </Button>
        )}

        {item.kind === 'team-installed' && (
          <>
            {/*
              No update button. Under auto-follow, being behind is a state that
              clears itself within a reconcile tick, so it is reported and not
              actioned — a button here would ask the user to do something that
              is already happening. The one case that genuinely needs a person
              is a local edit, and that gets the conflict bar below instead.
            */}
            {item.hasUpdate && !conflicted && !syncError && (
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {t('teamShare.skillUpdatingTo', 'updating to v{{v}}…', { v: item.latestVersion })}
              </span>
            )}
            {/*
              A sync that keeps failing has to say so. "updating to v3…" is
              true for ten minutes and a lie after that, and with no update
              button left there is nowhere else for the failure to appear —
              the member would run a retired version indefinitely, told only
              that an update was on its way.
            */}
            {syncError && !conflicted && (
              <button
                type="button"
                onClick={() => void reconcileSkills()}
                title={syncError}
                className="flex shrink-0 items-center gap-1 text-[11px] text-foreground underline-offset-2 hover:underline"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('teamShare.skillSyncFailedRetry', 'Update failed — retry')}
              </button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmAction('uninstall')}
              disabled={busy || agentOffline}
              className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('teamShare.skillUninstall', 'Uninstall')}
            </Button>
          </>
        )}

        {isPersonal && (
          <>
            {!isBuiltin ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfirmAction('delete')}
                disabled={busy || agentOffline}
                className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('teamShare.skillDelete', 'Delete')}
              </Button>
            ) : null}
            {canShare ? (
              <Button
                type="button"
                onClick={() => setShareOpen(true)}
                disabled={busy}
                className="h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90"
              >
                <Share2 className="h-3.5 w-3.5" />
                {t('teamShare.skillShare', 'Share')}
              </Button>
            ) : null}
          </>
        )}

        {canEdit && (
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
            className={cn(
              'h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90',
              !dirty && 'opacity-50',
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('teamShare.save', 'Save')}
          </Button>
        )}
      </div>

      {/*
        Another registry's pack is sitting on this slug. Auto-follow stops, and
        it has to say why: every registry installs into the same root, so the
        member sees "installed" here while the directory holds something else
        entirely, and none of the conflict exits apply — there is nothing of
        theirs to publish, fork, or discard.
      */}
      {localState?.state === 'foreign' && (
        <div className="border-b border-border px-5 py-3">
          <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground">
              {t('teamShare.skillForeign', 'A skill from another source already owns this name')}
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillForeignHint',
                'Nothing was changed. Uninstall the other copy, or rename one of them, and this will install on the next sync.',
              )}
            </p>
          </div>
        </div>
      )}

      {/*
        The team deleted this skill and auto-follow could not take the pack away,
        because the member had edited it. Their copy is theirs now — but nothing
        else on this screen says so: the row has quietly re-labelled itself
        "personal" (the agent inventory reports any unclaimed directory that
        way), which reads as though it was never a team skill at all.
      */}
      {retired === 'kept' && (
        <div className="border-b border-border px-5 py-3">
          <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground">
              {t('teamShare.skillRetiredKeptTitle', '团队已移除这个技能')}
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillRetiredKeptBody',
                '因为你改过它，本地这份保留了下来，现在是你自己的技能，不再跟随团队更新。',
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => dismissRetired(item.slug)}
                disabled={busy}
                className="h-8 text-[13px] text-muted-foreground hover:text-foreground"
              >
                {t('common.dismiss', 'Dismiss')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/*
        Auto-follow needed this path and something unrelated was sitting on it.
        Overwriting is right when a person clicks install; this arrived on its
        own, possibly seconds after they signed in on a new machine, so the file
        was set aside instead and they get to decide.
      */}
      {archivedPath && (
        <div className="border-b border-border px-5 py-3">
          <div className="rounded-[8px] border border-border border-l-2 border-l-foreground bg-paper px-4 py-3">
            <span className="text-[13px] font-semibold text-foreground">
              {t('teamShare.skillArchivedTitle', 'A skill of yours had this name')}
            </span>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t(
                'teamShare.skillArchivedBody',
                'The team version now owns {{slug}}. Your file was set aside, not deleted.',
                { slug: item.slug },
              )}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => void runKeepArchived()}
                disabled={busy}
                className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" />
                {t('teamShare.skillArchivedKeep', 'Keep mine as {{slug}}', {
                  slug: `${item.slug}-mine`,
                })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => dismissArchived(item.slug)}
                disabled={busy}
                className="h-8 text-[13px] text-muted-foreground hover:text-foreground"
              >
                {t('common.dismiss', 'Dismiss')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {conflicted && (
        <ConflictBar
          modified={localState?.modified ?? []}
          added={localState?.added ?? []}
          deleted={localState?.deleted ?? []}
          installedVersion={baseVersion}
          latestVersion={item.latestVersion}
          busy={busy}
          canPublish={canPublish}
          source={localState?.source ?? 'member'}
          onViewDiff={openDiff}
          onPublish={() => setPublishOpen(true)}
          onFork={() => setForkOpen(true)}
          onDiscard={() => void runDiscard()}
        />
      )}

      {item.status === 'deprecated' && item.supersededBy && (
        <button
          type="button"
          onClick={() => select('skills', item.supersededBy!)}
          className="flex w-full items-center gap-2 border-b border-border bg-muted/40 px-5 py-2 text-left text-[12px] text-muted-foreground hover:bg-muted/60"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('teamShare.skillSupersededBy', 'Deprecated — use {{slug}} instead', {
            slug: item.supersededBy,
          })}
        </button>
      )}

      {item.summary && (
        <div className="border-b border-border px-5 py-3 text-[13px] text-foreground">{item.summary}</div>
      )}
      <MetaRow item={item} ownerLabel={ownerLabel} />
      <UsageBoundary item={item} />
      {isRegistry && (
        <VersionHistory
          versions={versions}
          loading={versionsLoading}
          installedVersion={item.installedVersion}
          canRevert={canPublish}
          reverting={busy}
          onRevert={runRevert}
        />
      )}

      <div className="min-h-0 flex-1">
        {canEdit ? (
          <Suspense
            fallback={
              <div className="p-6 text-[13px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>
            }
          >
            <CodeEditor
              content={content}
              filename="SKILL.md"
              filePath={`${item.dirPath}/${item.filename}/SKILL.md`}
              onChange={setContent}
              isDark={isDark}
            />
          </Suspense>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
              {/*
                An installed skill with no local copy is not "not installed" —
                it is on the selected Agent's disk, which is another machine.
                Telling that user to install it is a dead end: installing again
                changes nothing, and the pane stays read-only either way.
              */}
              {item.kind === 'team-installed' && item.hasUpdate && !item.dirPath
                ? t(
                    'teamShare.skillSyncingBody',
                    '正在同步到 v{{v}}，完成后即可查看和编辑文件。',
                    { v: item.latestVersion ?? item.installedVersion ?? '?' },
                  )
                : item.installed || isPersonal
                  ? t(
                      'teamShare.skillOnRemoteAgentBody',
                      '这个 Skill 装在所选 Agent 的机器上，远程暂不支持查看和编辑内容。',
                    )
                  : t(
                      'teamShare.skillNotInstalledBody',
                      'Install this skill to read and edit its package contents on disk.',
                    )}
            </p>
            {latestChangelog && (
              <p className="max-w-md text-[12px] leading-relaxed text-faint">
                <span className="font-medium text-muted-foreground">
                  {t('teamShare.skillLatestChangelog', 'Latest changelog')}
                  {': '}
                </span>
                {latestChangelog}
              </p>
            )}
            {item.kind === 'team-available' && (
              <Button
                type="button"
                onClick={() => void runInstall()}
                disabled={busy || agentOffline || item.status === 'deprecated'}
                className="mt-1 h-8 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {t('teamShare.skillInstall', 'Install')}
              </Button>
            )}
          </div>
        )}
      </div>

      {canShare && (
        <ShareSheet
          item={item}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          onSubmit={runShare}
          busy={busy}
          takenSlugs={registrySlugs}
        />
      )}

      <PublishVersionSheet
        item={item}
        nextVersion={(item.latestVersion ?? 0) + 1}
        baseVersion={baseVersion}
        open={publishOpen}
        busy={busy}
        onClose={() => setPublishOpen(false)}
        onSubmit={runPublishVersion}
      />
      <ForkSheet
        slug={item.slug}
        open={forkOpen}
        busy={busy}
        onClose={() => setForkOpen(false)}
        onSubmit={runFork}
      />
      {diffOpen && (
        <DiffSheet
          slug={item.slug}
          diffs={diffs}
          loading={diffLoading}
          isDark={isDark}
          onClose={() => setDiffOpen(false)}
        />
      )}

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction === 'delete'
                ? t('teamShare.skillDeleteTitle', 'Delete Skill')
                : t('teamShare.skillUninstallTitle', 'Uninstall Skill')}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === 'delete'
                ? t(
                    'teamShare.skillDeleteConfirm',
                    'Are you sure you want to delete "{{name}}"? This permanently removes the skill from disk and cannot be undone.',
                    { name: item.name },
                  )
                : t(
                    'teamShare.skillUninstallConfirm',
                    'Uninstall "{{name}}"? You can install it again from Team Available later.',
                    { name: item.name },
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmAction(null)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void (confirmAction === 'delete' ? runDelete() : runUninstall())
              }
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {confirmAction === 'delete'
                ? t('teamShare.skillDelete', 'Delete')
                : t('teamShare.skillUninstall', 'Uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
