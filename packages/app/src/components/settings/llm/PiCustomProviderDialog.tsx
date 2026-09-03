import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Plus, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Editor for one custom pi provider — an entry in `~/.pi/agent/models.json`.
 *
 * This is how Ollama, LM Studio, vLLM, a corporate proxy or any other
 * OpenAI/Anthropic/Google-compatible endpoint gets into pi's model picker.
 *
 * # Round-tripping
 *
 * `models.json` supports far more than this form shows — per-model `compat`
 * flags, `modelOverrides`, `headers`, `oauth`. The unmodelled keys of the
 * provider being edited are carried in `rest` and written back untouched, so
 * opening a hand-written provider here and pressing save does not quietly
 * strip the parts the form has no field for.
 */

/** The API types `models.json` accepts (docs/models.md). */
const API_TYPES = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const

export interface PiCustomProviderDraft {
  id: string
  name: string
  baseUrl: string
  api: string
  apiKey: string
  models: string[]
}

/** Split a stored provider object into the form's fields and everything else. */
export function providerToDraft(
  id: string,
  provider: Record<string, unknown>,
): { draft: PiCustomProviderDraft; rest: Record<string, unknown> } {
  const { name, baseUrl, api, apiKey, models, ...rest } = provider
  return {
    draft: {
      id,
      name: typeof name === 'string' ? name : '',
      baseUrl: typeof baseUrl === 'string' ? baseUrl : '',
      api: typeof api === 'string' ? api : 'openai-completions',
      apiKey: typeof apiKey === 'string' ? apiKey : '',
      models: Array.isArray(models)
        ? models
            .map((m) =>
              typeof m === 'string' ? m : typeof (m as { id?: unknown })?.id === 'string'
                ? String((m as { id: string }).id)
                : '',
            )
            .filter(Boolean)
        : [],
    },
    rest,
  }
}

/**
 * Rebuild the stored object from the form.
 *
 * Models are merged rather than rewritten: a model the user did not rename
 * keeps whatever `compat`, `cost` or `contextWindow` it was hand-given. pi
 * fills in defaults for a bare `{id}`, so a newly added model needs nothing
 * else (docs/models.md: "only `id` is required per model").
 */
export function draftToProvider(
  draft: PiCustomProviderDraft,
  rest: Record<string, unknown>,
  previousModels: unknown,
): Record<string, unknown> {
  const byId = new Map<string, Record<string, unknown>>()
  if (Array.isArray(previousModels)) {
    for (const model of previousModels) {
      if (model && typeof model === 'object' && typeof (model as { id?: unknown }).id === 'string') {
        byId.set(String((model as { id: string }).id), model as Record<string, unknown>)
      }
    }
  }
  const provider: Record<string, unknown> = {
    ...rest,
    baseUrl: draft.baseUrl.trim(),
    api: draft.api,
    models: draft.models.map((id) => byId.get(id) ?? { id }),
  }
  if (draft.name.trim()) provider.name = draft.name.trim()
  else delete provider.name
  // An omitted apiKey is meaningful: it tells pi the credential comes from
  // /login, auth.json or the environment instead (docs/models.md).
  if (draft.apiKey.trim()) provider.apiKey = draft.apiKey.trim()
  else delete provider.apiKey
  return provider
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export function PiCustomProviderDialog({
  open,
  editingId,
  initialProvider,
  existingIds,
  onClose,
  onSave,
}: {
  open: boolean
  /** null when adding; the provider id when editing. */
  editingId: string | null
  initialProvider: Record<string, unknown> | null
  existingIds: string[]
  onClose: () => void
  onSave: (id: string, provider: Record<string, unknown>) => Promise<void>
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState<PiCustomProviderDraft>(() => emptyDraft())
  const [rest, setRest] = React.useState<Record<string, unknown>>({})
  const [modelDraft, setModelDraft] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setModelDraft('')
    if (editingId && initialProvider) {
      const parsed = providerToDraft(editingId, initialProvider)
      setDraft(parsed.draft)
      setRest(parsed.rest)
    } else {
      setDraft(emptyDraft())
      setRest({})
    }
  }, [open, editingId, initialProvider])

  const update = <K extends keyof PiCustomProviderDraft>(
    key: K,
    value: PiCustomProviderDraft[K],
  ) => setDraft((prev) => ({ ...prev, [key]: value }))

  const addModel = () => {
    const id = modelDraft.trim()
    if (!id || draft.models.includes(id)) {
      setModelDraft('')
      return
    }
    update('models', [...draft.models, id])
    setModelDraft('')
  }

  const handleSave = async () => {
    const id = draft.id.trim()
    if (!ID_PATTERN.test(id)) {
      setError(
        t(
          'settings.piLlm.customIdInvalid',
          'Provider ID 只能包含字母、数字、"-"、"_" 和 "."，且不超过 64 个字符。',
        ),
      )
      return
    }
    if (!editingId && existingIds.includes(id)) {
      setError(t('settings.piLlm.customIdTaken', 'Provider ID "{{id}}" 已存在。', { id }))
      return
    }
    if (!draft.baseUrl.trim()) {
      setError(t('settings.piLlm.customBaseUrlRequired', '请填写 Base URL。'))
      return
    }
    if (draft.models.length === 0) {
      setError(t('settings.piLlm.customModelsRequired', '至少添加一个模型 ID。'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(id, draftToProvider(draft, rest, initialProvider?.models))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {editingId
              ? t('settings.piLlm.customEditTitle', '编辑自定义 Provider')
              : t('settings.piLlm.customAddTitle', '添加自定义 Provider')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.piLlm.customDesc',
              '接入 Ollama、vLLM、LM Studio 或任何兼容 OpenAI / Anthropic / Google 的服务，写入 pi 的 models.json。',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto">
          <Field label={t('settings.piLlm.customId', 'Provider ID')}>
            <Input
              value={draft.id}
              // The id is the models.json key; renaming would create a second
              // provider and orphan every session pinned to the old one.
              disabled={Boolean(editingId)}
              placeholder="ollama"
              onChange={(e) => update('id', e.target.value)}
            />
          </Field>

          <Field label={t('settings.piLlm.customName', '显示名称')} optional>
            <Input
              value={draft.name}
              placeholder="Ollama (Local)"
              onChange={(e) => update('name', e.target.value)}
            />
          </Field>

          <Field label={t('settings.piLlm.customBaseUrl', 'Base URL')}>
            <Input
              value={draft.baseUrl}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => update('baseUrl', e.target.value)}
            />
          </Field>

          <Field label={t('settings.piLlm.customApi', 'API 类型')}>
            <Select value={draft.api} onValueChange={(value) => update('api', value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {API_TYPES.map((api) => (
                  <SelectItem key={api} value={api}>
                    {api}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('settings.piLlm.customApiKey', 'API Key')} optional>
            <Input
              value={draft.apiKey}
              placeholder="ollama"
              onChange={(e) => update('apiKey', e.target.value)}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-faint">
              {t(
                'settings.piLlm.customApiKeyHint',
                '支持 $ENV_VAR 引用环境变量、!command 执行命令取值。留空表示凭证来自登录或环境变量。本地服务（如 Ollama）填任意占位值即可。',
              )}
            </p>
          </Field>

          <Field label={t('settings.piLlm.customModels', '模型 ID')}>
            <div className="flex items-center gap-2">
              <Input
                value={modelDraft}
                placeholder="llama3.1:8b"
                onChange={(e) => setModelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addModel()
                  }
                }}
              />
              <Button variant="outline" size="sm" onClick={addModel}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {draft.models.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {draft.models.map((model) => (
                  <li
                    key={model}
                    className="flex items-center justify-between rounded-md bg-panel px-2 py-1"
                  >
                    <span className="font-mono text-[12px] text-foreground">{model}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={t('common.remove', '移除')}
                      onClick={() =>
                        update(
                          'models',
                          draft.models.filter((m) => m !== model),
                        )
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-panel p-3 text-[12.5px]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span className="text-foreground">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel', '取消')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {t('common.save', '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function emptyDraft(): PiCustomProviderDraft {
  return { id: '', name: '', baseUrl: '', api: 'openai-completions', apiKey: '', models: [] }
}

function Field({
  label,
  optional,
  children,
}: {
  label: string
  optional?: boolean
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div>
      <label className="mb-1 block text-[12px] font-medium text-foreground">
        {label}
        {optional && (
          <span className="ml-1 font-normal text-faint">{t('common.optional', '（可选）')}</span>
        )}
      </label>
      {children}
    </div>
  )
}
