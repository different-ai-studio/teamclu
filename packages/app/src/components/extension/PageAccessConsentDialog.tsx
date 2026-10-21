import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  hasOptionalHostAccess,
  requestOptionalHostAccess,
  resolveAgentPageAccess,
  usePageAccessConsentStore,
  type PageAccessDecision,
} from '@/lib/extension/page-access'

/**
 * Side-panel prompt shown when an AI agent asks to read the current page
 * (`get_page_dom`). Nothing is read until the user approves here.
 */
export function PageAccessConsentDialog() {
  const { t } = useTranslation()
  const pendingId = usePageAccessConsentStore((s) => s.pending?.id ?? null)
  const [hasHostAccess, setHasHostAccess] = React.useState(true)

  React.useEffect(() => {
    if (pendingId == null) return
    let cancelled = false
    void hasOptionalHostAccess().then((ok) => {
      if (!cancelled) setHasHostAccess(ok)
    })
    return () => {
      cancelled = true
    }
  }, [pendingId])

  const decide = React.useCallback(
    (decision: PageAccessDecision) => {
      if (decision === 'deny' || hasHostAccess) {
        resolveAgentPageAccess(decision)
        return
      }
      // Must run inside this click: Chrome only shows its permission prompt
      // for a user gesture.
      void requestOptionalHostAccess().then((granted) => {
        if (!granted) {
          toast.error(
            t(
              'settings.extension.pageAccess.permissionDenied',
              'Chrome site access was not granted, so the page was not shared.',
            ),
          )
        }
        resolveAgentPageAccess(granted ? decision : 'deny')
      })
    },
    [hasHostAccess, t],
  )

  return (
    <AlertDialog
      open={pendingId != null}
      onOpenChange={(open) => {
        if (!open) resolveAgentPageAccess('deny')
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('settings.extension.pageAccess.title', 'Share this page with the agent?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'settings.extension.pageAccess.description',
              'The AI agent in this conversation wants to read the page in your current tab (URL, title and visible text). It is sent to your team’s agent and AI model only if you allow it.',
            )}
          </AlertDialogDescription>
          {!hasHostAccess ? (
            <p className="text-[12px] text-muted-foreground">
              {t(
                'settings.extension.pageAccess.chromePromptHint',
                'Chrome will then ask you once to allow site access for TeamClu. You can revoke it any time in chrome://extensions.',
              )}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => decide('deny')}>
            {t('settings.extension.pageAccess.deny', 'Don’t allow')}
          </Button>
          <Button type="button" variant="outline" onClick={() => decide('session')}>
            {t('settings.extension.pageAccess.allowSession', 'Allow until panel closes')}
          </Button>
          <Button type="button" onClick={() => decide('once')}>
            {t('settings.extension.pageAccess.allowOnce', 'Allow once')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
