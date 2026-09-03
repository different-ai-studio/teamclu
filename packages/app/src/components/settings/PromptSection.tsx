import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquareText, Sparkles, Save } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { SettingCard, SectionHeader } from './shared'
import { toast } from 'sonner'
import { appStoragePrefix } from '@/lib/config/build-config'
import { isTauri } from '@/lib/utils'
import { encodeWorkspaceId, reloadDaemonRuntime } from '@/lib/daemon/daemon-local-client'
import { useEffectiveWorkspacePath } from '@/lib/workspace/effective-workspace'

// Legacy global storage key — kept only for one-time migration into
// per-workspace teamclu.json.
const LEGACY_STORAGE_KEY = `${appStoragePrefix}-system-prompt`

export const PromptSection = React.memo(function PromptSection() {
  const { t } = useTranslation()
  const workspacePath = useEffectiveWorkspacePath()
  const [systemPrompt, setSystemPrompt] = React.useState('')

  React.useEffect(() => {
    if (!isTauri() || !workspacePath) return
    let cancelled = false
    ;(async () => {
      try {
        const stored = await invoke<string>('load_system_prompt', { workspacePath })
        if (cancelled) return
        if (stored) {
          setSystemPrompt(stored)
          return
        }
        // One-time migration: seed from legacy global localStorage into
        // the current workspace, then clear the legacy entry.
        const legacy =
          typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_STORAGE_KEY) : null
        if (legacy) {
          setSystemPrompt(legacy)
          try {
            await invoke('save_system_prompt', { prompt: legacy, workspacePath })
            localStorage.removeItem(LEGACY_STORAGE_KEY)
          } catch (err) {
            console.error('[PromptSection] Legacy prompt migration failed:', err)
          }
        } else {
          setSystemPrompt('')
        }
      } catch (err) {
        console.error('[PromptSection] Failed to load system prompt:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  const handleSave = React.useCallback(async () => {
    try {
      await invoke('save_system_prompt', { prompt: systemPrompt, workspacePath: workspacePath ?? undefined })
      if (workspacePath) {
        try {
          await reloadDaemonRuntime(encodeWorkspaceId(workspacePath))
        } catch (reloadErr) {
          toast.warning(
            t(
              'settings.prompt.saveReloadWarning',
              'System prompt saved, but Agent runtime reload failed'
            ),
            {
              description:
                reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
              duration: 4000,
            }
          )
        }
      }
    } catch (err) {
      console.error('[PromptSection] Failed to save system prompt:', err)
      toast.error(
        t('settings.prompt.saveError', 'Failed to save system prompt'),
        { duration: 3000 }
      )
    }
  }, [systemPrompt, workspacePath, t])

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={MessageSquareText}
        title={t('settings.prompt.title', 'Prompt')}
        description={t('settings.prompt.description', 'Customize the system prompt and conversation behavior')}
        iconColor="text-green-500"
      />

      <SettingCard>
        <div className="space-y-4">
          <label className="text-[13px] font-medium flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-muted-foreground" />
            {t('settings.prompt.systemPrompt', 'System Prompt')}
          </label>
          <textarea
            className="flex min-h-[200px] w-full rounded-xl border border-input bg-background px-4 py-3 text-[13px] ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('settings.prompt.systemPromptPlaceholder', 'You are a helpful AI assistant that specializes in...')}
          />
          <p className="text-xs text-muted-foreground">
            {t('settings.prompt.systemPromptHint', "This prompt will be prepended to all conversations to guide the AI's behavior.")}
          </p>
        </div>
      </SettingCard>

      <SettingCard className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 border-green-200 dark:border-green-800">
        <div className="flex items-start gap-3">
          <Sparkles className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5" />
          <div>
            <p className="font-medium text-green-900 dark:text-green-100">{t('settings.prompt.proTip', 'Pro Tip')}</p>
            <p className="text-[13px] text-green-700 dark:text-green-300 mt-1">
              {t('settings.prompt.proTipDesc', 'A good system prompt includes your preferred response style, any domain expertise needed, and specific guidelines for the AI to follow.')}
            </p>
          </div>
        </div>
      </SettingCard>

      <Button className="w-full h-11 gap-2" onClick={handleSave}>
        <Save className="h-4 w-4" />
        {t('settings.prompt.saveChanges', 'Save Changes')}
      </Button>
    </div>
  )
})
