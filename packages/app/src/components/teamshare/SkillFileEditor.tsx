import * as React from 'react'
import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FolderSearch, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { encodeWorkspaceId, putDaemonSkill } from '@/lib/daemon-local-client'
import { revealInFinder } from '@/components/workspace/file-tree-operations'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'
import { useEffectiveWorkspacePath } from '@/lib/effective-workspace'
import { useIsDark } from './use-is-dark'

const CodeEditor = lazy(() => import('@/components/editors/CodeEditor'))

/**
 * Anything past this is opened in a real editor instead. CodeMirror will render
 * a multi-megabyte file, slowly, and a skill package that holds one is carrying
 * a data blob rather than instructions.
 */
const MAX_EDITABLE_BYTES = 512 * 1024

type Load =
  | { state: 'loading' }
  | { state: 'ready'; text: string }
  | { state: 'unreadable'; reason: 'binary' | 'too-large' | 'missing' }

/**
 * One file of a skill package, opened from the list column's folder tree.
 *
 * Replaces the skill detail rather than sitting beside it: the pane is one
 * column wide, and a script needs the height more than the metadata does. The
 * breadcrumb goes back.
 */
export function SkillFileEditor({ slug, rel }: { slug: string; rel: string }) {
  const { t } = useTranslation()
  const isDark = useIsDark()
  const workspacePath = useEffectiveWorkspacePath()
  // Same two-step lookup as SkillDetail: a personal skill colliding with a
  // registry name is addressed as `personal:<slug>`, and cross-links between
  // skills select by bare slug.
  const item = useTeamShareBrowserStore(
    (s) => s.skills.items.find((x) => x.id === slug) ?? s.skills.items.find((x) => x.slug === slug),
  )
  const select = useTeamShareBrowserStore((s) => s.select)
  const loadSection = useTeamShareBrowserStore((s) => s.loadSection)
  const reconcileSkills = useTeamShareBrowserStore((s) => s.reconcileSkills)

  const packDir = item && item.dirPath && item.filename ? `${item.dirPath}/${item.filename}` : null
  const filePath = packDir ? `${packDir}/${rel}` : null
  const fileName = rel.slice(rel.lastIndexOf('/') + 1)

  const [load, setLoad] = React.useState<Load>({ state: 'loading' })
  const [content, setContent] = React.useState('')
  const [baseline, setBaseline] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!filePath) return
    let cancelled = false
    setLoad({ state: 'loading' })
    void (async () => {
      try {
        const { stat, readTextFile } = await import('@tauri-apps/plugin-fs')
        const info = await stat(filePath)
        if (cancelled) return
        if (info.size > MAX_EDITABLE_BYTES) {
          setLoad({ state: 'unreadable', reason: 'too-large' })
          return
        }
        const text = await readTextFile(filePath)
        if (cancelled) return
        setContent(text)
        setBaseline(text)
        setLoad({ state: 'ready', text })
      } catch (e) {
        if (cancelled) return
        // readTextFile fails on invalid UTF-8, which is how a binary asset in
        // the package presents itself. Either way there is nothing to edit
        // here, and the message says which one it was.
        const missing = e instanceof Error && /No such file|os error 2/i.test(e.message)
        setLoad({ state: 'unreadable', reason: missing ? 'missing' : 'binary' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath])

  const dirty = load.state === 'ready' && content !== baseline

  const handleSave = React.useCallback(async () => {
    if (!item || !filePath || !dirty || saving) return
    setSaving(true)
    try {
      if (rel === 'SKILL.md') {
        // SKILL.md keeps going through the daemon, which normalises the
        // frontmatter and re-reads the catalog. Writing it straight to disk
        // here would give the same file two different save semantics
        // depending on which surface the user opened it from.
        if (!workspacePath) throw new Error('no workspace')
        const saved = await putDaemonSkill(encodeWorkspaceId(workspacePath), item.slug, {
          content,
          dirPath: item.dirPath,
          filename: item.filename,
        })
        if (saved === null) throw new Error('daemon rejected the update')
      } else {
        const { writeTextFile } = await import('@tauri-apps/plugin-fs')
        await writeTextFile(filePath, content)
      }
      setBaseline(content)
      await loadSection('skills', { force: true })
      // Same reason the SKILL.md editor does it: editing is what makes a team
      // pack differ from the version it was installed at, and that difference
      // is what pauses auto-follow and opens the publish path.
      await reconcileSkills().catch(() => {})
    } catch (e) {
      toast.error(
        t('teamShare.saveFailed', 'Save failed: {{msg}}', {
          msg: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setSaving(false)
    }
  }, [item, filePath, dirty, saving, rel, workspacePath, content, loadSection, reconcileSkills, t])

  // Cmd/Ctrl+S, the shortcut anyone editing a script will reach for first.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSave])

  if (!item || !filePath) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3" data-tauri-drag-region>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => select('skills', slug)}
          title={t('teamShare.skillBackToSkill', 'Back to {{slug}}', { slug: item.slug })}
          data-testid="skill-file-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => select('skills', slug)}
            className="block max-w-full truncate text-left text-[11px] font-medium uppercase tracking-wide text-faint hover:text-muted-foreground"
          >
            {item.name}
          </button>
          <div className="truncate font-mono text-[13.5px] font-semibold text-foreground">{rel}</div>
        </div>
        {dirty && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t('teamShare.skillFileModified', 'Modified')}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => void revealInFinder(filePath)}
          title={t('fileExplorer.revealInFinder', 'Reveal in Finder')}
        >
          <FolderSearch className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className={cn(
            'h-8 shrink-0 gap-1.5 bg-coral text-[13px] font-semibold text-white hover:bg-coral/90',
            !dirty && 'opacity-50',
          )}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('teamShare.save', 'Save')}
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {load.state === 'loading' ? (
          <div className="p-6 text-[13px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>
        ) : load.state === 'ready' ? (
          <Suspense
            fallback={
              <div className="p-6 text-[13px] text-muted-foreground">{t('common.loading', 'Loading…')}</div>
            }
          >
            <CodeEditor
              content={content}
              filename={fileName}
              filePath={filePath}
              onChange={setContent}
              isDark={isDark}
            />
          </Suspense>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
              {load.reason === 'too-large'
                ? t('teamShare.skillFileTooLarge', 'This file is too large to edit here.')
                : load.reason === 'missing'
                  ? t('teamShare.skillFileMissing', 'This file is no longer on disk.')
                  : t('teamShare.skillFileBinary', 'This file is not text, so it cannot be edited here.')}
            </p>
            {load.reason !== 'missing' && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void revealInFinder(filePath)}
                className="h-8 gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
              >
                <FolderSearch className="h-3.5 w-3.5" />
                {t('fileExplorer.revealInFinder', 'Reveal in Finder')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
