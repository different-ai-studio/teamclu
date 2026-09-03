import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { lazyNamed } from '@/lib/lazy-component'
import { useEverTrue } from '@/hooks/use-ever-true'
import { PaneLoading } from '@/components/ui/pane-loading'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { useUIStore } from '@/stores/ui'
import { removeStartupSkeleton } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { MessageSquarePlus } from 'lucide-react'
import * as React from 'react'
import i18n from '@/lib/i18n'
import { syncTrayMenuLabels } from '@/lib/ui/sync-tray-menu'

// This window is Settings, so laziness buys it nothing on its own — but the
// main window's entry imports this component too, and a static import here
// would put the whole settings subtree back into the shared startup chunk.
const Settings = lazyNamed(() => import('@/components/settings/Settings'), 'Settings')
const FeedbackDialog = lazyNamed(
  () => import('@/components/settings/FeedbackDialog'),
  'FeedbackDialog',
)

/**
 * Tray "本地 Agent 设置" surface — same Settings shell as the main app
 * (sidebar + Daemon/Local Agent sections), sized as a standalone window.
 * Does not restore the main desktop window.
 */
export function LocalAgentPanelApp() {
  const { t } = useTranslation()
  const openSettings = useUIStore((s) => s.openSettings)
  const [feedbackOpen, setFeedbackOpen] = React.useState(false)
  const mountFeedbackDialog = useEverTrue(feedbackOpen)

  useEffect(() => {
    openSettings('daemonGeneral')
    removeStartupSkeleton()
  }, [openSettings])

  // Language can be changed from Settings inside this window while the main
  // App is hidden — keep the native tray menu in sync.
  useEffect(() => {
    void syncTrayMenuLabels()
    const onLang = () => {
      void syncTrayMenuLabels()
    }
    i18n.on('languageChanged', onLang)
    return () => {
      i18n.off('languageChanged', onLang)
    }
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper" data-testid="local-agent-panel">
      <header
        className="flex h-12 shrink-0 flex-row items-center gap-2 border-b border-border bg-paper px-2"
        data-tauri-drag-region
      >
        <TrafficLights />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-bold leading-normal text-foreground">
            {t('closeToTray.panelTitle', '本地 Agent')}
          </h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-selected hover:text-foreground"
          onClick={() => setFeedbackOpen(true)}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {t('settings.feedback.title', 'Send Feedback')}
        </Button>
      </header>
      {mountFeedbackDialog ? (
        <React.Suspense fallback={null}>
          <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        </React.Suspense>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <React.Suspense fallback={<PaneLoading />}>
          <Settings />
        </React.Suspense>
      </div>
    </div>
  )
}
