import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
} from 'lucide-react'
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
import { copyToClipboard, openExternalUrl } from '@/lib/utils'
import {
  runPiLogin,
  type PiAuthEvent,
  type PiAuthPrompt,
  type PiAuthType,
  type PiLoginOutcome,
} from '@/lib/daemon-pi-auth'

/**
 * The UI half of `pi /login`.
 *
 * pi drives the flow and this dialog renders it. Everything on screen comes
 * from pi's own `AuthEvent`s and `AuthPrompt`s, which is what lets one dialog
 * serve every provider — the ChatGPT/Claude/Copilot subscription exchanges,
 * OpenRouter's PKCE, GitHub Enterprise domains, device codes, plain API keys —
 * without a branch per provider here. A provider pi adds tomorrow works in this
 * dialog unchanged.
 *
 * The one thing pi cannot do for us is open a browser: it publishes the
 * authorize URL and waits. We open it, and leave the URL on screen because a
 * user on a remote or sandboxed machine has to move it by hand.
 */

interface PendingPrompt {
  prompt: PiAuthPrompt
  resolve: (value: string | null) => void
}

export function PiLoginDialog({
  open,
  providerId,
  providerName,
  authType,
  workspaceId,
  onClose,
  onFinished,
}: {
  open: boolean
  providerId: string
  providerName: string
  authType: PiAuthType
  workspaceId?: string | null
  onClose: () => void
  /** Fired on any terminal outcome so the caller can refresh its list. */
  onFinished: (outcome: PiLoginOutcome) => void
}) {
  const { t } = useTranslation()
  const [events, setEvents] = React.useState<PiAuthEvent[]>([])
  const [pending, setPending] = React.useState<PendingPrompt | null>(null)
  const [draft, setDraft] = React.useState('')
  const [outcome, setOutcome] = React.useState<PiLoginOutcome | null>(null)
  const [running, setRunning] = React.useState(false)

  // Aborting this cancels the flow in the daemon too, so closing the dialog
  // never leaves pi parked on a question nobody will answer.
  const abortRef = React.useRef<AbortController | null>(null)
  const onFinishedRef = React.useRef(onFinished)
  onFinishedRef.current = onFinished

  React.useEffect(() => {
    if (!open) return
    setEvents([])
    setPending(null)
    setDraft('')
    setOutcome(null)
    setRunning(true)

    const controller = new AbortController()
    abortRef.current = controller

    void runPiLogin(
      providerId,
      authType,
      {
        onEvent: (event) => {
          setEvents((prev) => [...prev, event])
          // pi expects the user to be in a browser for this one, so open it
          // rather than making them click a link to start their own login.
          if (event.type === 'auth_url') void openExternalUrl(event.url)
        },
        onPrompt: (prompt, signal) =>
          new Promise<string | null>((resolve) => {
            let settled = false
            const finish = (value: string | null) => {
              if (settled) return
              settled = true
              setPending(null)
              setDraft('')
              resolve(value)
            }
            // pi withdrew the question — its loopback callback caught the
            // redirect while the user was still looking at the paste box.
            signal.addEventListener('abort', () => finish(null), { once: true })
            setDraft('')
            setPending({ prompt, resolve: finish })
          }),
      },
      { workspaceId, abort: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return
        setOutcome(result)
        setRunning(false)
        onFinishedRef.current(result)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const failure: PiLoginOutcome = {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          refreshError: null,
        }
        setOutcome(failure)
        setRunning(false)
        onFinishedRef.current(failure)
      })

    return () => controller.abort()
  }, [open, providerId, authType, workspaceId])

  const close = React.useCallback(() => {
    abortRef.current?.abort()
    onClose()
  }, [onClose])

  const submitPrompt = React.useCallback(
    (value: string | null) => {
      pending?.resolve(value)
    },
    [pending],
  )

  const authUrl = React.useMemo(
    () => [...events].reverse().find((e) => e.type === 'auth_url'),
    [events],
  ) as Extract<PiAuthEvent, { type: 'auth_url' }> | undefined
  const deviceCode = React.useMemo(
    () => [...events].reverse().find((e) => e.type === 'device_code'),
    [events],
  ) as Extract<PiAuthEvent, { type: 'device_code' }> | undefined
  const notes = events.filter((e) => e.type === 'info' || e.type === 'progress')

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {t('settings.piLlm.loginTitle', '登录 {{provider}}', { provider: providerName })}
          </DialogTitle>
          <DialogDescription>
            {authType === 'oauth'
              ? t('settings.piLlm.loginOauthDesc', '按 pi 的引导完成授权，凭证会保存到本机 pi。')
              : t('settings.piLlm.loginApiKeyDesc', '填写该 provider 的 API Key，凭证会保存到本机 pi。')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto">
          {authUrl && (
            <div className="rounded-lg border border-border bg-panel p-3">
              <p className="text-[12.5px] text-foreground">
                {authUrl.instructions ??
                  t('settings.piLlm.browserOpened', '已在浏览器中打开授权页面。')}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-paper px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {authUrl.url}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={t('common.copy', '复制')}
                  onClick={() => void copyToClipboard(authUrl.url)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={t('settings.piLlm.openInBrowser', '在浏览器中打开')}
                  onClick={() => void openExternalUrl(authUrl.url)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {deviceCode && (
            <div className="rounded-lg border border-border bg-panel p-3">
              <p className="text-[12.5px] text-muted-foreground">
                {t('settings.piLlm.deviceCodeHint', '在下面的网址输入这个配对码：')}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="rounded bg-paper px-2.5 py-1.5 font-mono text-[16px] font-semibold tracking-[0.18em] text-foreground">
                  {deviceCode.userCode}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t('common.copy', '复制')}
                  onClick={() => void copyToClipboard(deviceCode.userCode)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
              <Button
                variant="link"
                className="mt-1 h-auto p-0 text-[12px]"
                onClick={() => void openExternalUrl(deviceCode.verificationUri)}
              >
                {deviceCode.verificationUri}
                <ExternalLink className="ml-1 h-3 w-3" />
              </Button>
            </div>
          )}

          {notes.map((note, index) => (
            <div
              key={`${note.type}-${index}`}
              className="text-[12.5px] leading-relaxed text-muted-foreground"
            >
              {note.type === 'info' ? note.message : note.message}
              {note.type === 'info' &&
                note.links?.map((link) => (
                  <Button
                    key={link.url}
                    variant="link"
                    className="ml-1 h-auto p-0 text-[12px]"
                    onClick={() => void openExternalUrl(link.url)}
                  >
                    {link.label ?? link.url}
                  </Button>
                ))}
            </div>
          ))}

          {pending && (
            <PromptForm
              prompt={pending.prompt}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submitPrompt}
            />
          )}

          {!pending && running && (
            <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('settings.piLlm.waiting', '等待授权完成…')}
            </div>
          )}

          {outcome?.status === 'succeeded' && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-panel p-3 text-[12.5px]">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <div>
                <p className="text-foreground">
                  {t('settings.piLlm.loginSucceeded', '{{provider}} 登录成功。', {
                    provider: providerName,
                  })}
                </p>
                {outcome.refreshError && (
                  <p className="mt-1 text-muted-foreground">
                    {t(
                      'settings.piLlm.refreshWarning',
                      '模型列表刷新失败（{{error}}），将使用缓存的模型。',
                      { error: outcome.refreshError },
                    )}
                  </p>
                )}
              </div>
            </div>
          )}

          {outcome?.status === 'failed' && outcome.error && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-panel p-3 text-[12.5px]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span className="text-foreground">{outcome.error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant={outcome ? 'default' : 'outline'} onClick={close}>
            {outcome ? t('common.done', '完成') : t('common.cancel', '取消')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One `AuthPrompt`, rendered as the control its type calls for. */
function PromptForm({
  prompt,
  draft,
  onDraftChange,
  onSubmit,
}: {
  prompt: PiAuthPrompt
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (value: string | null) => void
}) {
  const { t } = useTranslation()

  if (prompt.type === 'select') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[12.5px] text-foreground">{prompt.message}</p>
        {prompt.options.map((option) => (
          <Button
            key={option.id}
            variant="outline"
            className="h-auto justify-start px-3 py-2 text-left"
            onClick={() => onSubmit(option.id)}
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-[12.5px] text-foreground">{option.label}</span>
              {option.description && (
                <span className="text-[11px] text-muted-foreground">{option.description}</span>
              )}
            </span>
          </Button>
        ))}
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        // An empty answer is a real answer for optional prompts (pressing enter
        // on a GitHub Enterprise domain means "github.com"), so it is sent as
        // typed rather than treated as a cancel.
        onSubmit(draft)
      }}
    >
      <label className="text-[12.5px] text-foreground" htmlFor="pi-auth-prompt">
        {prompt.message}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="pi-auth-prompt"
          autoFocus
          type={prompt.type === 'secret' ? 'password' : 'text'}
          placeholder={prompt.placeholder}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <Button type="submit" size="sm">
          {t('common.submit', '提交')}
        </Button>
      </div>
    </form>
  )
}
