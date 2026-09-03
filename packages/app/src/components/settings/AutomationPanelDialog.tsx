import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui'
import { SettingsSectionBody } from './section-registry'

export function AutomationPanelDialog() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.automationPanelOpen)
  const setOpen = useUIStore((s) => s.setAutomationPanelOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-label={t('sidebar.localDaemonAutomation', 'Automation')}
        className="flex h-[min(780px,calc(100vh-5rem))] w-[min(720px,calc(100vw-4rem))] max-w-none grid-cols-none flex-col gap-0 overflow-hidden rounded-[14px] border-border bg-paper p-0 shadow-2xl sm:max-w-none"
        showCloseButton={false}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex h-10 shrink-0 flex-row items-center justify-end border-b border-border-soft bg-paper px-3 py-0">
          <DialogTitle className="sr-only">
            {t('sidebar.localDaemonAutomation', 'Automation')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              'settings.cron.automationDesc',
              'Schedule recurring tasks for your AI agent. Jobs run automatically and can deliver results through configured channels.',
            )}
          </DialogDescription>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-selected hover:text-foreground"
            onClick={() => setOpen(false)}
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <SettingsSectionBody section="automation" />
      </DialogContent>
    </Dialog>
  )
}
