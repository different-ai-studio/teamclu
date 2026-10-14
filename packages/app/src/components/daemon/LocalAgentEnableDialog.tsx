import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import {
  settleLocalAgentConfirm,
  settleLocalAgentEnable,
  startLocalAgentEnable,
  useLocalAgentGateStore,
} from '@/lib/daemon/local-agent-gate'

/**
 * The on-demand local Agent setup (#1678): what `ensureLocalAgentEnabled`
 * opens when a feature needs amuxd and it is off. Mounted once, next to the
 * other app-wide dialogs. Also hosts the yes/no prompts about the local Agent
 * (`confirmLocalAgentAction`).
 */
export function LocalAgentEnableDialog() {
  const { t } = useTranslation()
  const phase = useLocalAgentGateStore((s) => s.phase)
  const confirm = useLocalAgentGateStore((s) => s.confirm)

  React.useEffect(() => {
    useLocalAgentGateStore.setState({ hostMounted: true })
    return () => useLocalAgentGateStore.setState({ hostMounted: false })
  }, [])

  return (
    <>
      <Dialog
        open={phase !== 'closed'}
        onOpenChange={(open) => {
          // Closing mid-setup only stops waiting: the setup carries on, and the
          // feature that asked can be used again once it is done.
          if (!open) settleLocalAgentEnable(false)
        }}
      >
        <DialogContent className="max-w-[440px]" data-testid="local-agent-enable-dialog">
          {phase === 'intro' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('localAgent.enableTitle', 'Enable the local Agent')}</DialogTitle>
                <DialogDescription className="text-[13px] leading-relaxed">
                  {t(
                    'localAgent.enableIntro',
                    'This needs the Agent that runs on this computer. Enabling it starts the local daemon and installs its runtime (Node.js and pi), then carries on with what you were doing.',
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => settleLocalAgentEnable(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  className="bg-coral text-coral-foreground hover:opacity-90"
                  onClick={startLocalAgentEnable}
                >
                  {t('localAgent.enableAction', 'Enable')}
                </Button>
              </DialogFooter>
            </>
          ) : phase === 'running' ? (
            <DaemonOnboardingWizard variant="dialog" onDone={() => settleLocalAgentEnable(true)} />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) settleLocalAgentConfirm(false)
        }}
      >
        <AlertDialogContent size="sm" className="max-w-[400px]" data-testid="local-agent-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap text-[13px] leading-relaxed">
              {confirm?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settleLocalAgentConfirm(false)}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => settleLocalAgentConfirm(true)}>
              {confirm?.confirmLabel ?? t('common.continue', 'Continue')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
