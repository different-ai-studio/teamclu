import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingCard } from './shared'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { daemonTeamsDisplayPath } from '@/lib/daemon/daemon-paths'

const RESET_CONFIRM_TEXT = 'RESET'

export function DaemonManualResetCard({
  onResetComplete,
}: {
  onResetComplete: () => void
}) {
  const { t } = useTranslation()
  const forceReset = useDaemonOnboardingStore((s) => s.forceReset)
  const busy = useDaemonOnboardingStore((s) => s.busy)

  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [confirmText, setConfirmText] = React.useState('')
  const [resetError, setResetError] = React.useState<string | null>(null)

  const canConfirm = confirmText.trim() === RESET_CONFIRM_TEXT

  const handleReset = React.useCallback(async () => {
    setResetError(null)
    try {
      await forceReset()
      const err = useDaemonOnboardingStore.getState().error
      if (err) {
        setResetError(err)
        return
      }
      setConfirmOpen(false)
      setConfirmText('')
      onResetComplete()
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err))
    }
  }, [forceReset, onResetComplete])

  return (
    <>
      <SettingCard>
        <div className="space-y-3">
          <div>
            <h4 className="text-[13px] font-semibold text-foreground">
              {t('settings.daemonGeneral.manualReset.title', '疑难问题排查')}
            </h4>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              {t('settings.daemonGeneral.manualReset.description', {
                path: daemonTeamsDisplayPath,
                defaultValue:
                  'If the local daemon is in a bad state and other recovery steps fail, you can clear the local binding and re-initialize. Team shared directories ({{path}}) are not deleted.',
              })}
            </p>
          </div>
          {resetError && !confirmOpen && (
            <p className="text-[12px] text-destructive">{resetError}</p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2 border-destructive/30 text-destructive hover:bg-destructive/5"
            disabled={busy}
            onClick={() => {
              setConfirmText('')
              setResetError(null)
              setConfirmOpen(true)
            }}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            {t('settings.daemonGeneral.manualReset.action', '重置本地 daemon')}
          </Button>
        </div>
      </SettingCard>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open)
          if (!open) setConfirmText('')
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('settings.daemonGeneral.manualReset.confirmTitle', '重置本地 daemon？')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'settings.daemonGeneral.manualReset.confirmDescription',
                '将删除本机 daemon 的身份与配置文件（daemon.toml、backend.toml 等），之后需要重新绑定 agent。请输入 RESET 确认。',
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={RESET_CONFIRM_TEXT}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className="font-mono"
          />
          {resetError && confirmOpen && (
            <p className="text-[12px] text-destructive">{resetError}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmOpen(false)}
            >
              {t('common.cancel', '取消')}
            </Button>
            <Button
              type="button"
              disabled={!canConfirm || busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40"
              onClick={() => void handleReset()}
            >
              {t('settings.daemonGeneral.manualReset.confirmAction', '确认重置')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
