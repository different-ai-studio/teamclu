/**
 * GatewayStatusCard - Common gateway status display with expand/collapse,
 * start/stop/restart buttons, and toggle switch.
 * Used by all channel settings.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  BookOpen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingCard, ToggleSwitch, StatusBadge } from './shared'

interface GatewayStatusCardProps {
  /** The channel icon component */
  icon: React.ReactNode
  /** The gateway display name (e.g., "Discord Gateway") */
  title: string
  /** Gateway status */
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  /** Optional status detail line (e.g., "Connected as @bot") */
  statusDetail?: React.ReactNode
  /** Optional error message */
  errorMessage?: string
  /** Whether the panel is expanded */
  expanded: boolean
  /** Toggle expanded state */
  onToggleExpanded: () => void
  /** Whether the channel is enabled */
  enabled: boolean
  /** Toggle enabled state */
  onToggleEnabled: (enabled: boolean) => void
  /** Whether the store is loading */
  isLoading: boolean
  /** Whether gateway is connecting */
  isConnecting: boolean
  /** Whether gateway is running (connected or connecting) */
  isRunning: boolean
  /** Whether there are unsaved changes that need a restart */
  hasChanges: boolean
  /** Handle start/stop (legacy — kept for back-compat with callers that haven't migrated to onStart/onStop) */
  onStartStop?: () => void
  /** Handle restart (stop + save + start) */
  onRestart: () => void
  /** Start the gateway (called when toggle flips ON and not already running) */
  onStart?: () => void | Promise<void>
  /** Stop the gateway (called when toggle flips OFF and currently running) */
  onStop?: () => void | Promise<void>
  /** Whether start should be disabled (e.g., missing credentials) */
  startDisabled?: boolean
  /** Optional: show setup wizard button */
  onOpenWizard?: () => void
  /** Collapsible content */
  children?: React.ReactNode
}

export function GatewayStatusCard({
  icon,
  title,
  status,
  statusDetail,
  errorMessage,
  expanded,
  onToggleExpanded,
  enabled,
  onToggleEnabled,
  isLoading,
  isConnecting,
  isRunning,
  hasChanges,
  onRestart,
  onStart,
  onStop,
  startDisabled: _startDisabled,
  onOpenWizard,
  children,
}: GatewayStatusCardProps) {
  const { t } = useTranslation()

  const handleToggle = async (next: boolean) => {
    onToggleEnabled(next)
    if (next && !isRunning && onStart) {
      await onStart()
    } else if (!next && isRunning && onStop) {
      await onStop()
    }
  }

  return (
    <SettingCard className="!p-3">
      {/* Header Row - always visible */}
      <div className="flex items-center justify-between">
        <button
          onClick={onToggleExpanded}
          className="flex items-center gap-3 flex-1 text-left"
        >
          {icon}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{title}</span>
              <StatusBadge status={status} />
            </div>
            {statusDetail}
            {errorMessage && (
              <p className="text-xs text-red-500">{errorMessage}</p>
            )}
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          )}
        </button>
        <div className="flex items-center gap-1.5 ml-2">
          {onOpenWizard && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenWizard}
              className="h-7 w-7 p-0"
              title={t('settings.channels.startSetup', 'Start Setup')}
            >
              <BookOpen className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
          <ToggleSwitch
            enabled={enabled}
            onChange={handleToggle}
            disabled={isLoading || isConnecting}
          />
          {isRunning && hasChanges && (
            <Button
              variant="default"
              size="sm"
              onClick={onRestart}
              disabled={isLoading || isConnecting}
              className="h-7 gap-1.5 px-2.5 text-[12px]"
            >
              {isLoading || isConnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('settings.channels.restart', 'Restart')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Collapsible Content */}
      {expanded && children && (
        <div className="mt-5 pt-5 border-t space-y-5">
          {children}
        </div>
      )}
    </SettingCard>
  )
}
