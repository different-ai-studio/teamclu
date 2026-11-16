import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, Globe, Loader2, Rocket, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { deployDisabledReason } from '@/lib/apps/app-list-helpers'
import { requestAgentDeploy } from '@/lib/apps/app-deploy-prompt'
import { openAppPreview } from '@/lib/tabs/app-tabs'
import { AppDeploymentControl } from './AppDeploymentControl'
import type { AppRow } from '@/lib/backend/types'

/** States in which a deploy is already under way on the server. */
const IN_FLIGHT = ['awaiting_build', 'building', 'deploying']

/**
 * Deploy, preview and uninstall, in the app's control panel.
 *
 * Deploy does not run the pipeline here: it hands the job to the app's agent as
 * a chat message (see `requestAgentDeploy`), so the user watches the agent
 * check, commit, push and publish in the conversation, and approves the
 * preflight through the native dialog the agent's tool raises.
 */
export function AppDeployActions({ app }: { app: AppRow }) {
  const { t } = useTranslation()
  const [requesting, setRequesting] = React.useState(false)

  const blocked = deployDisabledReason(app)
  const inFlight = IN_FLIGHT.includes(app.fcStatus ?? '')
  const deployDisabled = requesting || inFlight || app.provisionStatus !== 'ready' || !!blocked
  const previewUrl = app.publicUrl ?? app.fcEndpoint
  const previewDisabled = !previewUrl || app.fcStatus !== 'live'

  const handleDeploy = async () => {
    if (deployDisabled) return
    setRequesting(true)
    try {
      const sessionId = await requestAgentDeploy(app)
      if (!sessionId) {
        toast.error(t('apps.deployPromptFailed', '没能把部署请求发给 AI，请打开应用会话后重试。'))
      }
    } catch (error) {
      toast.error(
        t('apps.deployPromptFailed', '没能把部署请求发给 AI，请打开应用会话后重试。'),
        { description: error instanceof Error ? error.message : String(error) },
      )
    } finally {
      setRequesting(false)
    }
  }

  const liveUrl = app.fcStatus === 'live' ? (app.publicUrl ?? app.fcEndpoint ?? null) : null

  return (
    <div className="space-y-2.5" data-testid="app-deploy-actions">
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          disabled={deployDisabled}
          onClick={() => void handleDeploy()}
          title={t('apps.deployViaAgentHint', '发一条消息让 AI 检查、提交并部署')}
          data-testid="app-deploy-actions-deploy"
          className="h-8 gap-1.5 rounded-[7px] text-[12.5px]"
        >
          {requesting || inFlight ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
          {inFlight ? t('apps.deploying', '部署中…') : t('apps.deploy', '部署')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={previewDisabled}
          onClick={() => openAppPreview(app)}
          data-testid="app-deploy-actions-preview"
          className="h-8 gap-1.5 rounded-[7px] text-[12.5px]"
        >
          <Eye className="h-3.5 w-3.5" />
          {t('apps.preview', '预览')}
        </Button>
      </div>

      <p className="flex items-center gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
        <Sparkles className="h-3 w-3 shrink-0 text-faint" />
        {t('apps.deployViaAgentHint', '发一条消息让 AI 检查、提交并部署')}
      </p>

      {blocked && !['uninstalling', 'uninstall_failed'].includes(app.fcStatus ?? '') && (
        <p className="text-[11.5px] leading-snug text-faint">
          {t(blocked, '第三方登录尚未支持部署')}
        </p>
      )}

      {/* The uninstall control reads its own permission from the server and
          renders nothing for a visitor; this row only needs a deployment. */}
      {app.fcStatus && app.fcStatus !== 'not_deployed' && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border-soft pt-2.5">
          {liveUrl && (
            <a
              href={liveUrl}
              onClick={(event) => {
                event.preventDefault()
                openAppPreview(app)
              }}
              title={liveUrl}
              className="flex min-w-0 flex-1 basis-[140px] items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
              data-testid="app-deploy-actions-live-url"
            >
              <Globe className="h-3.5 w-3.5 shrink-0 text-faint" />
              <span className="min-w-0 truncate font-mono text-[11.5px]">
                {liveUrl.replace(/^https?:\/\//, '')}
              </span>
            </a>
          )}
          <AppDeploymentControl app={app} compact disabled={requesting || inFlight} />
        </div>
      )}
    </div>
  )
}
