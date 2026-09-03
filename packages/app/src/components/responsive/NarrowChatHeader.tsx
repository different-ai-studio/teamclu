import * as React from 'react'
import { SquarePen, Users, List, MoreHorizontal, Settings, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SessionListColumn } from '@/components/sidebar/SessionListColumn'
import { SIDEBAR_INTERACTIVE_CURSOR } from '@/components/sidebar/sidebar-interactive-cursor'
import { cn } from '@/lib/utils'
import { TrafficLights } from '@/components/ui/traffic-lights'
import { hideExtensionSettingsButton } from '@/lib/config/build-config'
import { capabilities } from '@/lib/config/platform'
import { createQuickSession, describeQuickSessionFailure } from '@/lib/session/create-quick-session'
import { useUIStore } from '@/stores/ui'
import { useSessionSelectionStore } from '@/stores/session-selection-store'
import { toast } from 'sonner'

export function NarrowChatHeader() {
  const { t } = useTranslation()
  const embedMode = useUIStore((s) => s.embedMode)
  const currentView = useUIStore((s) => s.currentView)
  const activeSessionId = useSessionSelectionStore((s) => s.activeSessionId)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [moreOpen, setMoreOpen] = React.useState(false)
  const [creatingSession, setCreatingSession] = React.useState(false)

  const showHeaderNewChat = currentView === 'chat' && !!activeSessionId
  const showSettingsButton = !hideExtensionSettingsButton

  const handleQuickNewChat = React.useCallback(() => {
    if (creatingSession) return
    setCreatingSession(true)
    void createQuickSession()
      .then((result) => {
        if (result.ok) return
        const { title, description } = describeQuickSessionFailure(result.reason, t)
        toast.error(title, {
          description,
          ...(result.reason === 'no_agent'
            ? {
                action: {
                  label: t('chat.quickSessionSetDefaultAgent', 'Set default agent'),
                  onClick: () => useUIStore.getState().openSettings('daemonGeneral'),
                },
              }
            : {}),
        })
      })
      .catch((e) => {
        console.error('[NarrowChatHeader] quick create failed', e)
        const { title, description } = describeQuickSessionFailure('server_error', t)
        toast.error(title, { description })
      })
      .finally(() => setCreatingSession(false))
  }, [creatingSession, t])

  const openSettings = React.useCallback(() => {
    setMoreOpen(false)
    // Let the dropdown fully dismiss before mounting the settings dialog —
    // otherwise Radix can leave a blocking overlay in the extension side panel.
    window.setTimeout(() => useUIStore.getState().openSettings(), 0)
  }, [])

  return (
    <div className="flex h-11 shrink-0 items-center border-b border-border bg-background px-2" data-tauri-drag-region>
      <TrafficLights />
      <div className="flex items-center gap-0.5">
        {showHeaderNewChat ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleQuickNewChat}
            disabled={creatingSession}
            title={t('chat.newChat', 'New Chat')}
          >
            {creatingSession ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SquarePen className="h-4 w-4" />
            )}
          </Button>
        ) : null}
        {!embedMode ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => useUIStore.getState().openNewSessionDialog()}
            title={t('chat.newMultiPersonSession', 'Group session')}
          >
            <Users className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setSheetOpen(true)}
          title={t('sidebar.sessions', 'Sessions')}
        >
          <List className="h-4 w-4" />
        </Button>

        {showSettingsButton ? (
          capabilities.pageCapture ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => useUIStore.getState().openSettings()}
              title={t('navigation.settings', 'Settings')}
            >
              <Settings className="h-4 w-4" />
            </Button>
          ) : (
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={openSettings}>
                  <Settings className="mr-2 h-4 w-4" />
                  {t('navigation.settings', 'Settings')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : null}
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="h-[80vh] p-0 flex flex-col" showCloseButton={false}>
          <SheetHeader className="sr-only">
            <SheetTitle>{t('sidebar.sessions', 'Sessions')}</SheetTitle>
          </SheetHeader>
          <div className={cn('flex-1 min-h-0', SIDEBAR_INTERACTIVE_CURSOR)}>
            <SessionListColumn onDismiss={() => setSheetOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
