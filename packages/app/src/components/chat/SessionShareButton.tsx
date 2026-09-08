import * as React from 'react'
import { Link2, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { buildSessionDeeplink } from '@/lib/session/session-deeplink'
import { canSystemShare, isShareCancelled, systemShareText } from '@/lib/session/session-share'

const TRIGGER_CLASS =
  'shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

/**
 * Share the current session: copy its deeplink, or hand it to the OS share
 * sheet. On a platform with no share sheet (Windows today) the menu would hold
 * a single item, so the button stays the one-click copy it has always been.
 */
export function SessionShareButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  // Host OS — it cannot change while this is mounted.
  const [systemShareAvailable] = React.useState(canSystemShare)

  const copyLink = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildSessionDeeplink(sessionId))
      toast.success(t('chat.shareLinkCopied', '会话链接已复制'))
    } catch {
      toast.error(t('chat.shareLinkCopyFailed', '复制失败'))
    }
  }, [sessionId, t])

  const shareToSystem = React.useCallback(async () => {
    // The native sheet is a popover: it needs a rect on screen to hang from,
    // and the trigger is the only thing the user was looking at.
    const rect = triggerRef.current?.getBoundingClientRect()
    try {
      await systemShareText(
        buildSessionDeeplink(sessionId),
        rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : undefined,
      )
    } catch (e) {
      if (isShareCancelled(e)) return
      console.error('[session-share] system share failed', e)
      toast.error(t('chat.shareFailed', '分享失败'))
    }
  }, [sessionId, t])

  if (!systemShareAvailable) {
    return (
      <button
        type="button"
        data-testid="session-share-button"
        onClick={() => void copyLink()}
        className={TRIGGER_CLASS}
        title={t('chat.copyShareLink', '复制链接')}
      >
        <Link2 className="h-3.5 w-3.5" />
      </button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-testid="session-share-button"
          className={TRIGGER_CLASS}
          title={t('chat.shareSession', '分享会话')}
        >
          <Share2 className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[10rem]">
        <DropdownMenuItem onClick={() => void copyLink()}>
          <Link2 />
          {t('chat.copyShareLink', '复制链接')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void shareToSystem()}>
          <Share2 />
          {t('chat.shareViaSystem', '系统分享…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
