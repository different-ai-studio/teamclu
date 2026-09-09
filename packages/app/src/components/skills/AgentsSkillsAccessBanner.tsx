import { useTranslation } from 'react-i18next'
import { AlertCircle, FolderOpen, RefreshCw, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { revealInFinder } from '@/components/workspace/file-tree-operations'
import { cn } from '@/lib/utils'
import { useAgentsSkillsAccessStore } from '@/stores/agents-skills-access-store'

function kindMessage(
  t: (key: string, fallback: string, opts?: Record<string, string>) => string,
  kind: string | undefined,
  path: string,
  detail: string,
): string {
  switch (kind) {
    case 'os_permission':
      return t(
        'skills.access.osPermissionBody',
        'Your user account cannot read or write {{path}}. Fix ownership in Finder (Get Info → Sharing & Permissions), then retry.',
        { path },
      )
    case 'tauri_scope':
      return t(
        'skills.access.tauriScopeBody',
        'The app does not have filesystem access to {{path}}. Click Retry to re-authorize, or open the folder in Finder.',
        { path },
      )
    case 'home_missing':
      return t(
        'skills.access.homeMissingBody',
        'Could not resolve your home directory, so ~/.agents/skills is unavailable.',
      )
    case 'create_failed':
      return t(
        'skills.access.createFailedBody',
        'Could not create {{path}}: {{detail}}',
        { path, detail },
      )
    default:
      return detail || t('skills.access.genericBody', 'Skills cannot be installed until ~/.agents/skills is accessible.')
  }
}

export function AgentsSkillsAccessBanner() {
  const { t } = useTranslation()
  const access = useAgentsSkillsAccessStore((s) => s.access)
  const dismissed = useAgentsSkillsAccessStore((s) => s.dismissed)
  const checking = useAgentsSkillsAccessStore((s) => s.checking)
  const check = useAgentsSkillsAccessStore((s) => s.check)
  const dismiss = useAgentsSkillsAccessStore((s) => s.dismiss)

  if (!access || access.ok || dismissed) {
    return null
  }

  const path = access.path || '~/.agents/skills'
  const body = kindMessage(t, access.kind, path, access.message)

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-[13px] text-destructive',
      )}
      data-testid="agents-skills-access-banner"
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 text-ink-2">
        <p className="font-medium text-foreground">
          {t('skills.access.title', 'Cannot access skills folder')}
        </p>
        <p className="text-[12px] text-muted-foreground">{body}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 gap-1 px-2 text-[12px]"
        onClick={() => void revealInFinder(path)}
        data-testid="agents-skills-access-reveal"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        {t('skills.access.reveal', 'Reveal in Finder')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 gap-1 px-2 text-[12px]"
        disabled={checking}
        onClick={() => void check()}
        data-testid="agents-skills-access-retry"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
        {t('skills.access.retry', 'Retry')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 gap-1 px-2 text-[12px] text-muted-foreground"
        onClick={() => dismiss()}
        data-testid="agents-skills-access-dismiss"
      >
        <X className="h-3.5 w-3.5" />
        {t('skills.access.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
