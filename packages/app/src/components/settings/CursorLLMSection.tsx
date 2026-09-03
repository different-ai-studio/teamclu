import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CheckCircle2, Cpu, ExternalLink, Key, Loader2, Save, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getCursorAgentSettings,
  restartLocalDaemon,
  saveCursorAgentSettings,
} from '@/lib/daemon/daemon-local-client'
import { cn, isTauri } from '@/lib/utils'
import { SectionHeader, SettingCard } from './shared'

const CURSOR_API_KEY_DOCS = 'https://cursor.com/docs/account/teams/admin-api'

export function CursorLLMSection() {
  const { t } = useTranslation()
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [apiKeyConfigured, setApiKeyConfigured] = React.useState(false)
  const [apiKeyDraft, setApiKeyDraft] = React.useState('')
  const [defaultModel, setDefaultModel] = React.useState('composer-2.5')

  const load = React.useCallback(async () => {
    if (!isTauri()) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const settings = await getCursorAgentSettings()
      setApiKeyConfigured(settings.apiKeyConfigured)
      setDefaultModel(settings.defaultModel)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const handleSave = React.useCallback(async () => {
    if (!isTauri()) return
    const trimmedKey = apiKeyDraft.trim()
    if (!apiKeyConfigured && !trimmedKey) {
      setError(t('settings.llm.cursorKeyRequired', '请先填写 Cursor API Key'))
      return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const { requiresRestart } = await saveCursorAgentSettings({
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
        defaultModel: defaultModel.trim() || 'composer-2.5',
      })
      if (requiresRestart) {
        await restartLocalDaemon()
      }
      setApiKeyDraft('')
      setApiKeyConfigured(apiKeyConfigured || Boolean(trimmedKey))
      setSaved(true)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [apiKeyConfigured, apiKeyDraft, defaultModel, load, t])

  return (
    <div>
      <SectionHeader
        icon={Cpu}
        title={t('settings.llm.cursorTitle', 'Cursor 模型')}
        description={t(
          'settings.llm.cursorDesc',
          '使用 Cursor SDK（Composer 等）作为本地 Agent 运行时。在此配置 API Key，无需编辑 daemon.toml。',
        )}
      />

      <SettingCard>
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', '加载中…')}
          </div>
        ) : (
          <div className="space-y-5 p-4">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-[13px] font-medium">
                <Key className="h-4 w-4 text-muted-foreground" />
                {t('settings.llm.cursorApiKey', 'Cursor API Key')}
                {apiKeyConfigured ? (
                  <span className="inline-flex items-center gap-1 rounded-md border border-border-soft bg-panel px-1.5 py-0.5 font-mono text-[10.5px] font-normal text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    {t('settings.llm.cursorKeyConfigured', '已配置')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-md border border-coral/30 bg-coral/5 px-1.5 py-0.5 font-mono text-[10.5px] font-normal text-coral">
                    <AlertCircle className="h-3 w-3" />
                    {t('settings.llm.cursorKeyMissing', '未配置')}
                  </span>
                )}
              </label>
              <Input
                type="password"
                value={apiKeyDraft}
                onChange={(e) => {
                  setApiKeyDraft(e.target.value)
                  setSaved(false)
                }}
                placeholder={
                  apiKeyConfigured
                    ? t('settings.llm.cursorKeyPlaceholderSet', '留空则保留现有 Key')
                    : t('settings.llm.cursorKeyPlaceholder', 'crsr_…')
                }
                className="font-mono text-[12.5px]"
                autoComplete="off"
              />
              <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                <Shield className="mt-0.5 h-3 w-3 shrink-0" />
                {t(
                  'settings.llm.cursorKeyStorage',
                  'Key 仅保存在本机 ~/.amuxd/daemon.toml，经 daemon HTTP 写入，不会上传到 TeamClu 云端。',
                )}
              </p>
              <a
                href={CURSOR_API_KEY_DOCS}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {t('settings.llm.cursorKeyDocs', '如何获取 Cursor API Key')}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium">
                {t('settings.llm.cursorDefaultModel', '默认模型')}
              </label>
              <Input
                value={defaultModel}
                onChange={(e) => {
                  setDefaultModel(e.target.value)
                  setSaved(false)
                }}
                placeholder="composer-2.5"
                className="font-mono text-[12.5px]"
              />
              <p className="text-[11.5px] text-muted-foreground">
                {t(
                  'settings.llm.cursorDefaultModelHint',
                  '会话首次 attach 时使用；可在聊天输入栏切换其他 Cursor 模型。',
                )}
              </p>
            </div>

            {error ? (
              <div className="flex items-start gap-2 text-[12.5px] text-red-600">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            {saved ? (
              <div className="flex items-center gap-2 text-[12.5px] text-emerald-600">
                <CheckCircle2 className="h-4 w-4" />
                {t('settings.llm.cursorSaved', '已保存并重启 daemon')}
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button
                onClick={() => void handleSave()}
                disabled={saving || (!apiKeyConfigured && !apiKeyDraft.trim())}
                className="gap-2"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {t('settings.llm.cursorSave', '保存')}
              </Button>
            </div>
          </div>
        )}
      </SettingCard>

      {!loading && !apiKeyConfigured ? (
        <SettingCard className={cn('mt-4 border-coral/20 bg-coral/5')}>
          <div className="flex items-start gap-3 p-4 text-[12.5px] leading-relaxed text-ink-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-coral" />
            <p>
              {t(
                'settings.llm.cursorSetupRequired',
                'Cursor 运行时需要在上方配置 API Key 后才能回复消息。保存后 daemon 会自动重启。',
              )}
            </p>
          </div>
        </SettingCard>
      ) : null}
    </div>
  )
}
