import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SKILLS_CHANGED_EVENT } from '@/lib/skills/changed-event'
import {
  encodeWorkspaceId,
  notifyDaemonSkillsChanged,
} from '@/lib/daemon/daemon-local-client'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

export function RefreshSkillsHeaderButton({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await notifyDaemonSkillsChanged(encodeWorkspaceId(workspacePath))
      window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT))
      void useWorkspaceRuntimeRefreshStore.getState().refreshNow(workspacePath)
      if (result.status === 'pending_active_turn') {
        toast.message(t('chat.refreshSkillsPending', '当前会话正在运行，Skills 将在结束后生效'))
      } else {
        toast.success(t('chat.refreshSkillsApplied', 'Skills 已刷新'))
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('chat.refreshSkillsFailed', 'Skills 刷新失败'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      data-testid="refresh-skills-header-button"
      disabled={busy}
      onClick={() => void onClick()}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      title={t('chat.refreshSkills', '强制刷新 Skills')}
    >
      <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
    </button>
  )
}
