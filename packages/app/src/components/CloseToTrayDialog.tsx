import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/lib/utils'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type CloseActionChoice = 'tray' | 'quit'

/**
 * Desktop-only: listens for `window-close-requested` and shows a confirm dialog.
 * Default selection is tray (keep amuxd). Optional remember → Rust preference file.
 */
export function CloseToTrayHost() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<CloseActionChoice>('tray')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    void (async () => {
      unlisten = await listen('window-close-requested', () => {
        if (cancelled) return
        setChoice('tray')
        setRemember(false)
        setOpen(true)
      })
    })()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const onCancel = useCallback(() => {
    if (busy) return
    setOpen(false)
  }, [busy])

  const onConfirm = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      if (remember) {
        await invoke('set_window_close_preference', { action: choice })
      }
      if (choice === 'tray') {
        await invoke('hide_main_to_tray')
      } else {
        await invoke('quit_app')
      }
      setOpen(false)
    } catch (e) {
      console.error('[CloseToTray] confirm failed', e)
    } finally {
      setBusy(false)
    }
  }, [busy, choice, remember])

  if (!isTauri()) return null

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="max-w-[400px] gap-0 p-5 sm:rounded-[14px]" data-testid="close-to-tray-dialog">
        <DialogHeader className="gap-2 text-left">
          <DialogTitle className="text-[15px] font-bold">
            {t('closeToTray.title', '关闭 TeamClu？')}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t(
              'closeToTray.description',
              '本地 Agent（amuxd）目前由桌面托管。你可以把它留在托盘继续跑任务，或一并退出。',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label={t('closeToTray.title', '关闭 TeamClu？')}>
          <ChoiceCard
            selected={choice === 'tray'}
            onSelect={() => setChoice('tray')}
            title={t('closeToTray.trayTitle', '最小化到托盘')}
            desc={t(
              'closeToTray.trayDesc',
              '隐藏窗口；本地 Agent 继续运行，可接跨设备消息与定时任务。',
            )}
            testId="close-choice-tray"
          />
          <ChoiceCard
            selected={choice === 'quit'}
            onSelect={() => setChoice('quit')}
            title={t('closeToTray.quitTitle', '退出并停止 Agent')}
            desc={t(
              'closeToTray.quitDesc',
              '关闭窗口并停止 amuxd / opencode。适合彻底下班。',
            )}
            testId="close-choice-quit"
          />
        </div>

        <label className="mt-3 flex items-center gap-2 text-[12px] text-foreground">
          <input
            type="checkbox"
            className="accent-[var(--coral)]"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            data-testid="close-remember"
          />
          {t('closeToTray.remember', '记住我的选择（可在设置里改）')}
        </label>

        <DialogFooter className="mt-4 gap-2 sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            data-testid="close-cancel"
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="bg-coral text-white hover:bg-coral/90"
            onClick={() => void onConfirm()}
            disabled={busy}
            data-testid="close-confirm"
          >
            {t('closeToTray.confirm', '确定')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChoiceCard(props: {
  selected: boolean
  onSelect: () => void
  title: string
  desc: string
  testId: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      data-testid={props.testId}
      onClick={props.onSelect}
      className={cn(
        'grid grid-cols-[18px_1fr] gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors',
        props.selected
          ? 'border-coral/45 bg-coral-soft/25'
          : 'border-border bg-background hover:border-foreground/16',
      )}
    >
      <span
        className={cn(
          'mt-0.5 h-[14px] w-[14px] rounded-full border',
          props.selected
            ? 'border-coral bg-coral shadow-[inset_0_0_0_3px_var(--paper)]'
            : 'border-border',
        )}
        aria-hidden
      />
      <span>
        <span className="block text-[13px] font-semibold text-foreground">{props.title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{props.desc}</span>
      </span>
    </button>
  )
}
