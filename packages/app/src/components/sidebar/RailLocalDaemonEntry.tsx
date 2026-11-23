import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LocalDaemonCard, useLocalDaemonAgent } from '@/components/sidebar/LocalDaemonCard'
import { LocalDaemonMark, localDaemonStatusLabel } from '@/components/sidebar/LocalDaemonRow'
import { useRailPopover } from '@/components/sidebar/use-rail-popover'

/**
 * The local agent on the collapsed rail: its mark, coloured by status, with a
 * dot on the corner unless it is online. Clicking it opens the full card
 * (status, automation, workspaces) beside the rail — the card has no room on
 * the rail itself, and medium windows cannot pin the full sidebar to show it.
 *
 * The card stays mounted while the panel is closed (only hidden), so a dialog
 * it opened — the agent's profile — is not torn down when the click into that
 * dialog closes the panel.
 */
export function RailLocalDaemonEntry() {
  const { t } = useTranslation()
  const { absent, actor, runtimeStatus } = useLocalDaemonAgent()
  const { open, onOpenChange, contentProps } = useRailPopover()

  if (!absent && !actor) return null

  const label = absent
    ? t('localAgent.notInstalled', 'Local agent is not installed')
    : `${actor?.display_name ?? ''} · ${localDaemonStatusLabel(runtimeStatus, t)}`
  const needsAttention = absent || runtimeStatus === 'offline' || runtimeStatus === 'daemonMqttDisconnected'

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          data-testid="rail-local-daemon"
          className={cn(
            'relative flex h-10 w-full items-center justify-center rounded-lg transition-colors duration-150 hover:bg-black/[0.04]',
            open && 'bg-black/[0.04]',
          )}
        >
          {absent ? (
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground/10 text-muted-foreground">
              <Bot className="h-4 w-4" />
            </span>
          ) : (
            <LocalDaemonMark runtimeStatus={runtimeStatus} />
          )}
          {needsAttention ? (
            <span
              aria-hidden
              className={cn(
                'absolute left-1/2 top-1 ml-2 h-2 w-2 rounded-full ring-2 ring-sidebar',
                runtimeStatus === 'daemonMqttDisconnected' ? 'bg-amber-400' : 'bg-coral',
              )}
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={12}
        forceMount
        {...contentProps}
        className="w-[260px] rounded-xl border-0 bg-transparent p-0 shadow-[0_8px_24px_-8px_rgba(28,27,25,0.22)] data-[state=closed]:hidden"
      >
        <LocalDaemonCard />
      </PopoverContent>
    </Popover>
  )
}
