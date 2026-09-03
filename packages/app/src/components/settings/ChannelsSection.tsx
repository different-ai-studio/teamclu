import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, AlertCircle, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useChannelsStore } from '@/stores/channels'
import { SectionHeader, SettingCard } from './channels/shared'
import { DiscordChannel } from './channels/Discord'
import { FeishuChannel } from './channels/Feishu'
import { EmailChannel } from './channels/Email'
import { KookChannel } from './channels/Kook'
import { WeComChannel } from './channels/Wecom'
import { WeChatChannel } from './channels/Wechat'
import { SeaTalkChannel } from './channels/Seatalk'
import { useFeatures } from '@/lib/remote-features'
import { useShallow } from 'zustand/react/shallow'

// Main Channels Section Component
export function ChannelsSection() {
  const { t } = useTranslation()
  // Resolved per render, not once at module scope: these flags now arrive
  // from the Cloud API and can change mid-session.
  const channelsConfig = useFeatures().channels
  const { discord, isLoading, error, loadConfig, clearError } = useChannelsStore(
    useShallow((s) => ({ discord: s.discord, isLoading: s.isLoading, error: s.error, loadConfig: s.loadConfig, clearError: s.clearError })),
  )

  // Load config on mount to sync UI state
  React.useEffect(() => {
    loadConfig()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-2">
      <SectionHeader
        icon={MessageSquare}
        title={t('settings.channels.title', 'Channels')}
        description={t('settings.channels.description', 'Configure message gateway channels for external communication')}
        iconColor="text-indigo-500"
      />

      {/* Error Message */}
      {error && (
        <SettingCard className="border-destructive/20 bg-destructive/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-red-900 dark:text-red-100">{t('common.error', 'Error')}</p>
              <p className="text-[13px] text-red-700 dark:text-red-300 mt-1">{error}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={clearError}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </SettingCard>
      )}

      {/* Loading State */}
      {isLoading && !discord && (
        <SettingCard>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </SettingCard>
      )}

      {/* Channel Components */}
      {channelsConfig.discord && <DiscordChannel />}
      {channelsConfig.feishu && <FeishuChannel />}
      {channelsConfig.email && <EmailChannel />}
      {channelsConfig.kook && <KookChannel />}
      {channelsConfig.wecom && <WeComChannel />}
      {channelsConfig.wechat && <WeChatChannel />}
      {channelsConfig.seatalk && <SeaTalkChannel />}
    </div>
  )
}
