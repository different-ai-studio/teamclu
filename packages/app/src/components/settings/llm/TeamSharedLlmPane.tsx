import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { HostLlmConfig, type LlmModelEntry } from '@/components/settings/team/HostLlmConfig'
import { getBackend } from '@/lib/backend'
import { useCurrentTeamStore } from '@/stores/current-team'
import { humanizeFcError } from '@/lib/fc-error'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful save so the caller can reload the shared model. */
  onSaved?: () => void
}

/**
 * Modal dialog (styled like "Add Custom") for the team-shared ("host") LLM —
 * the checkbox + proxy base URL + model list block, opened from the local LLM
 * settings screen. Owner-only entry point.
 *
 * The team LLM config is CLOUD-stored per team (single source of truth):
 * - READ:  `GET /v1/teams/:id/workspace-config` → `llm`.
 * - WRITE: `PUT /v1/teams/:id/llm-config`.
 *
 * There is no on-disk mirror: the daemon materializes `opencode.json`'s
 * `provider.team` directly from the cloud config at agent-spawn time, so the
 * shared LLM converges on first install without waiting for a git clone.
 */
export function TeamSharedLlmPane({ open, onOpenChange, onSaved }: Props) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const [enabled, setEnabled] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState('')
  const [models, setModels] = React.useState<LlmModelEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Load the current config each time the dialog opens, from the cloud.
  React.useEffect(() => {
    if (!open || !teamId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const llm = await getBackend().teamWorkspaceConfig.loadLlmConfig(teamId)
        if (cancelled) return
        if (llm) {
          setEnabled(llm.enabled)
          setBaseUrl(llm.baseUrl ?? '')
          setModels(llm.models ?? [])
        } else {
          setEnabled(false)
          setBaseUrl('')
          setModels([])
        }
      } catch (err) {
        if (!cancelled) setError(humanizeFcError(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, teamId])

  const handleSave = async () => {
    if (!teamId) {
      setError(t('settings.team.noCurrentTeam', '当前没有团队'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      // Cloud is the single source of truth; the daemon reads it directly.
      await getBackend().teamWorkspaceConfig.saveLlmConfig(teamId, {
        enabled,
        baseUrl: enabled ? baseUrl || null : null,
        models: enabled ? models : [],
      })
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      setError(humanizeFcError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('settings.llm.teamSharedModel', '团队共享模型')}</DialogTitle>
          <DialogDescription>
            {t(
              'settings.team.hostLlmPaneDesc',
              '为团队配置共享 AI 模型代理地址与模型列表，所有成员可直接使用。',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('common.loading', '加载中…')}
            </div>
          ) : (
            <>
              <HostLlmConfig
                enabled={enabled}
                onEnabledChange={setEnabled}
                baseUrl={baseUrl}
                onBaseUrlChange={setBaseUrl}
                models={models}
                onModelsChange={setModels}
                disabled={saving}
              />
            </>
          )}
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close', '关闭')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('settings.team.saveLlm', '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
