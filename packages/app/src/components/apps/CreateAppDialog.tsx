import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ChevronRight, Loader2, Save } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAppsStore } from '@/stores/apps-store'
import { APP_TYPES, DEFAULT_APP_TYPE, type AppTypeId } from '@/lib/app-types'

type Visibility = 'personal' | 'team'

/**
 * Whether a repo URL is one `git clone` will treat as an address.
 *
 * Mirrors the same allowlist the cloud API and the daemon apply — http(s) /
 * ssh / git://, or scp-like `git@host:path`. Checked here so a typo is a red
 * line under the field instead of a 400 after the app row already exists.
 */
export function isValidGitRemoteUrl(raw: string): boolean {
  const url = raw.trim()
  if (!url) return true // empty means "no import", which is the default
  return /^(https?|ssh|git):\/\/[^\s]+$/.test(url) || /^[^\s:/@]+@[^\s:/@]+:[^\s]+$/.test(url)
}

interface CreateAppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
}

export function CreateAppDialog({ open, onOpenChange, teamId }: CreateAppDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [appType, setAppType] = React.useState<AppTypeId>(DEFAULT_APP_TYPE)
  const [visibility, setVisibility] = React.useState<Visibility>('personal')
  const [gitRemoteUrl, setGitRemoteUrl] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setName('')
      setAppType(DEFAULT_APP_TYPE)
      setVisibility('personal')
      setGitRemoteUrl('')
      setSubmitting(false)
      setError(null)
    }
  }, [open])

  const trimmed = name.trim()
  const trimmedRepo = gitRemoteUrl.trim()
  const repoValid = isValidGitRemoteUrl(gitRemoteUrl)
  const canSubmit = !!trimmed && !!teamId && repoValid && !submitting

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const app = await useAppsStore.getState().create({
        teamId,
        name: trimmed,
        type: appType,
        visibility,
        gitRemoteUrl: trimmedRepo || null,
      })
      onOpenChange(false)
      setName('')
      setAppType(DEFAULT_APP_TYPE)
      setVisibility('personal')
      setGitRemoteUrl('')

      // Drop the user straight into a conversation that is already underway.
      // Only once the files exist — an opening message telling the agent to
      // read AGENTS.md is useless if the template was never written.
      if (app.provisionStatus === 'ready') {
        const { startAppFirstSession } = await import('@/lib/app-session')
        const sessionId = await startAppFirstSession(app)
        if (sessionId) {
          useAppsStore.getState().recordAppSession(app.id, sessionId)
          useAppsStore.getState().selectApp(app.id)
          const { useUIStore } = await import('@/stores/ui')
          useUIStore.getState().setSidebarFilter({ kind: 'apps' })
          await useUIStore.getState().switchToSession(sessionId, { keepSidebarFilter: true })
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('apps.createError', '创建失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[min(520px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden border-border bg-background p-0 shadow-xl">
        <DialogHeader className="border-b border-border-soft bg-paper px-5 py-4">
          <div className="flex items-center gap-3 pr-8">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-coral-soft bg-coral/5 px-2.5 text-[12.5px] font-semibold text-coral">
              <AppWindow className="h-3.5 w-3.5" />
              App
            </span>
            <ChevronRight className="h-4 w-4 text-faint" />
            <DialogTitle className="text-[15px] font-bold text-foreground">
              {t('apps.createTitle', '新建')}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t('apps.createTitle', '新建')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 py-6">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-app-name" className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.nameLabel', 'Name')}
            </label>
            <Input
              id="create-app-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apps.namePlaceholder', '起个名字')}
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-app-repo" className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.repoLabel', 'Repository URL (optional)')}
            </label>
            <Input
              id="create-app-repo"
              value={gitRemoteUrl}
              onChange={(e) => setGitRemoteUrl(e.target.value)}
              placeholder={t('apps.repoPlaceholder', 'https://github.com/owner/repo.git')}
              disabled={submitting}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={!repoValid}
              className={cn(!repoValid && 'border-amber-500/60')}
            />
            <span className={cn('text-[11.5px]', repoValid ? 'text-faint' : 'text-amber-700')}>
              {repoValid
                ? t('apps.repoHint', "Fill this in and the repo is cloned as the app's code, with no template written.")
                : t('apps.repoInvalid', 'Must be an http(s), ssh or git@host:owner/repo.git address.')}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.typeLabel', 'Type')}
            </span>
            <div className="flex flex-col gap-1.5">
              {APP_TYPES.map((meta) => {
                const selected = appType === meta.id
                return (
                  <button
                    key={meta.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={submitting}
                    onClick={() => setAppType(meta.id)}
                    className={cn(
                      'flex flex-col gap-0.5 rounded-[9px] border px-3 py-2.5 text-left transition-colors disabled:opacity-50',
                      selected
                        ? 'border-coral bg-coral/5'
                        : 'border-border-soft bg-paper hover:bg-selected/30',
                    )}
                  >
                    <span
                      className={cn(
                        'text-[13px] font-semibold',
                        selected ? 'text-coral' : 'text-foreground',
                      )}
                    >
                      {t(meta.labelKey, meta.label)}
                    </span>
                    <span className="text-[12px] text-muted-foreground">
                      {t(meta.descriptionKey, meta.description)}
                    </span>
                  </button>
                )
              })}
            </div>
            {!!trimmedRepo && (
              <span className="text-[11.5px] text-faint">
                {t('apps.typeWithRepoHint', 'When importing a repo, the type only decides how it deploys — no template files are written.')}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-muted-foreground">
              {t('apps.visibilityLabel', 'Visibility')}
            </span>
            <div className="flex gap-2">
              {(['personal', 'team'] as const).map((v) => (
                <label
                  key={v}
                  className={cn(
                    'flex flex-1 cursor-pointer items-center gap-2 rounded-[9px] border px-3 py-2.5 text-[13px] transition-colors',
                    visibility === v
                      ? 'border-coral bg-coral/5 text-foreground'
                      : 'border-border-soft bg-paper text-ink-2 hover:bg-selected/30',
                  )}
                >
                  <input
                    type="radio"
                    name="create-app-visibility"
                    value={v}
                    checked={visibility === v}
                    onChange={() => setVisibility(v)}
                    disabled={submitting}
                    className="h-3.5 w-3.5 accent-coral"
                  />
                  {v === 'personal'
                    ? t('apps.visibilityPersonal', 'Personal')
                    : t('apps.visibilityTeam', 'Team')}
                </label>
              ))}
            </div>
            <span className="text-[11.5px] text-faint">
              {t(
                'apps.visibilityHint',
                '可见性只控制团队内谁能看到此应用；上线后若未启用登录，任何拿到链接的人均可访问。',
              )}
            </span>
          </div>

          {error && (
            <div className="rounded-[9px] border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-700">
              {t('apps.createError', '创建失败')}: {error}
            </div>
          )}
        </div>

        <div className="border-t border-border-soft bg-paper px-5 py-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="h-9 rounded-[9px]"
          >
            {t('apps.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="float-right h-9 rounded-[9px] bg-coral px-5 text-white hover:bg-coral/90"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t('apps.submit', 'Create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
