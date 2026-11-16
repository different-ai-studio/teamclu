import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { AppRow } from '@/lib/backend/types'

/**
 * The HTTPS address to `git clone` an app from any terminal, under the signed-in
 * account (docs/specs/2026-11-16-app-platform-identity-design.md §5).
 *
 * Only per-account apps have one. The checkout this computer keeps cannot stand
 * in for it: its `origin` is still the SSH address, rewritten to HTTPS by a
 * repo-local rule, so copying it elsewhere would go over SSH and fail.
 */
export function appGitCloneUrl(app: Pick<AppRow, 'gitAccountAuth' | 'gitHttpUrl'>): string | null {
  return app.gitAccountAuth && app.gitHttpUrl?.trim() ? app.gitHttpUrl.trim() : null
}

export function AppGitUrlRow({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)
  const url = appGitCloneUrl(app)

  React.useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  if (!url) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch (error) {
      toast.error(t('apps.gitUrl.copyFailed', '复制失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div className="space-y-1.5" data-testid="app-git-url">
      <div className="group flex items-center gap-1 rounded-[7px] border border-border-soft bg-panel/60 py-1 pl-2.5 pr-1">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-faint" />
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground"
          title={url}
          data-testid="app-git-url-value"
        >
          {url}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 rounded-[5px] text-muted-foreground hover:text-foreground"
          aria-label={t('apps.gitUrl.copy', '复制 git 地址')}
          title={t('apps.gitUrl.copy', '复制 git 地址')}
          onClick={() => void copy()}
          data-testid="app-git-url-copy"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <p className="text-[11.5px] leading-snug text-faint">
        {t(
          'apps.gitUrl.hint',
          '在任意终端里 git clone 这个地址即可，用的是你在 TeamClu 登录的身份，不用输密码。',
        )}
      </p>
    </div>
  )
}
