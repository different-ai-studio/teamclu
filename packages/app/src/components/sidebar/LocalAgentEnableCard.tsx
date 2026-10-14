import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Laptop, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'

/**
 * The sidebar's local Agent card while the local Agent is off (#1678).
 *
 * Same place and frame as `LocalDaemonCard`, so the slot never disappears: a
 * user who only talks to remote agents sees that this computer can run one too,
 * and enables it from here. Enabling from this card never touches the member
 * default — that is reserved for the "no default agent anywhere" path.
 */
export function LocalAgentEnableCard() {
  const { t } = useTranslation()
  const enabling = useDaemonOnboardingStore((s) => s.status === 'starting' || s.busy)
  const [requested, setRequested] = React.useState(false)

  const handleEnable = async () => {
    if (requested) return
    setRequested(true)
    try {
      const { ensureLocalAgentEnabled } = await import('@/lib/daemon/local-agent-gate')
      if (await ensureLocalAgentEnabled({ skipIntro: true })) {
        toast.success(t('localAgent.enabledToast', 'Local Agent enabled'))
      }
    } finally {
      setRequested(false)
    }
  }

  const busy = requested || enabling

  return (
    <div
      className="flex flex-col gap-2 rounded-xl bg-paper p-2.5 shadow-[0_2px_8px_rgba(28,27,25,0.05),0_1px_2px_rgba(28,27,25,0.03)] ring-1 ring-black/[0.05] dark:ring-white/10"
      data-testid="local-agent-enable-card"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/10 text-muted-foreground">
          <Laptop className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold leading-tight">
            {t('localAgent.cardTitle', 'Local Agent')}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-faint">
            {t('localAgent.cardNotEnabled', 'Not enabled on this computer')}
          </div>
        </div>
      </div>
      <p className="text-[11.5px] leading-4 text-muted-foreground">
        {t(
          'localAgent.cardHint',
          'Run an agent on this computer for local files, team file sync and local apps.',
        )}
      </p>
      <Button
        size="sm"
        className="h-8 w-full rounded-[8px] bg-coral text-coral-foreground hover:opacity-90"
        disabled={busy}
        onClick={() => void handleEnable()}
      >
        {busy ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('localAgent.enabling', 'Enabling…')}
          </span>
        ) : (
          t('localAgent.enableAction', 'Enable')
        )}
      </Button>
    </div>
  )
}
