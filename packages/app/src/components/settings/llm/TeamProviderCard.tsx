import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Lock, Users, Zap } from 'lucide-react'

import { cn } from '@/lib/utils'
import { TEAM_MODEL_TIERS, TEAM_SHARED_PROVIDER_ID } from '@/lib/agent/team-provider'
import { useCurrentTeamStore } from '@/stores/current-team'
import { SettingCard } from '../shared'

/**
 * The team gateway, pinned to the top of the LLM provider list.
 *
 * Not a normal provider card: there is nothing to connect, disconnect or
 * remove. The team's plan *is* the credential — members bill against the team's
 * credits through the daemon's `ai:invoke` proxy — so exposing a delete button
 * would only offer a way to break a working setup with no way to put it back
 * from this screen.
 *
 * The three tiers are hardcoded (`TEAM_MODEL_TIERS`) rather than read from the
 * cloud team config, for the reason spelled out on that constant.
 *
 * Only rendered for the opencode and pi runtimes. cursor and claude-code drive
 * their own vendor accounts and have no hook for pointing a session at our
 * gateway, so pinning a card they cannot honour would just be a broken promise.
 */
export function TeamProviderCard({ className }: { className?: string }) {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const [expanded, setExpanded] = React.useState(false)

  // No team, no team gateway — nothing to bill against.
  if (!teamId) return null

  return (
    <SettingCard
      className={cn(
        '!p-3 cursor-pointer border-primary/40 bg-primary/5 transition-all hover:border-primary/60',
        expanded && 'border-primary/60',
        className,
      )}
    >
      <div
        className="flex items-center justify-between"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Users className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-[13px] font-medium">
                {t('settings.llm.teamProviderName', '团队模型')}
              </p>
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                <Lock className="h-2.5 w-2.5" />
                {t('settings.llm.teamProviderPinned', '内置')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.llm.teamProviderDesc', '由团队统一提供并计费，无需配置')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-faint">{TEAM_SHARED_PROVIDER_ID}</span>
          <ChevronRight
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-1.5 border-t pt-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t('settings.llm.availableModels', 'Available Models')}
          </p>
          {TEAM_MODEL_TIERS.map((tier) => (
            <div
              key={tier.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted/50"
            >
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{t(tier.labelKey, tier.label)}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">{tier.id}</span>
            </div>
          ))}
        </div>
      )}
    </SettingCard>
  )
}
