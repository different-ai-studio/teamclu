import * as React from 'react'
import { useTranslation } from 'react-i18next'

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
import { cn } from '@/lib/utils'
import { useLocalAgentInstallStore } from '@/stores/local-agent-install'

/** Shared install prompt for every surface that needs a local agent and does not have one. */
export function LocalAgentRequiredCard({
  className,
  label,
}: {
  className?: string
  /** Replaces the short default line when a surface needs to say what is blocked. */
  label?: string
}) {
  const { t } = useTranslation()
  const openWizard = useLocalAgentInstallStore((s) => s.openWizard)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  return (
    <>
      <div
        className={cn(
          'flex w-full items-center gap-2 rounded-[12px] border border-dashed border-foreground/25 bg-transparent px-2.5 py-2',
          className,
        )}
      >
        <p className="min-w-0 flex-1 text-left text-[12px] font-normal leading-snug text-muted-foreground">
          {label ?? t('localAgent.notInstalled', 'Local agent is not installed')}
        </p>
        <button
          type="button"
          className="shrink-0 bg-transparent px-0.5 text-[12px] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setConfirmOpen(true)}
        >
          {t('localAgent.install', 'Install')}
        </button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('localAgent.confirmTitle', 'Install the local agent?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'localAgent.confirmBody',
                'This installs and sets up a local agent on this computer.',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                openWizard()
              }}
            >
              {t('localAgent.install', 'Install')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
