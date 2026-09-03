import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { useTeamPermissions } from '@/lib/team/team-permissions'
import { useActorDirectory } from '@/stores/actor-directory-store'
import { SettingCard } from './shared'

const NONE_VALUE = '__none__'

/**
 * Team-wide default agent picker.
 *
 * Lives in General next to the other team-scoped rows. It used to sit in the
 * Team Shared section, which is gone — that section existed to pick a share
 * mode, and this setting was never about sharing.
 *
 * Only owner/admin can edit the value; other roles see a read-only notice. The
 * agent list is filtered to team-visible agents only (the backend enforces this
 * constraint as well). Renders nothing without a current team.
 */
export function TeamDefaultAgentCard() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const { canManageTeam } = useTeamPermissions()

  const teamDefaultAgentId = useMemberPreferencesStore((s) => s.teamDefaultAgentId)
  const teamDefaultLoading = useMemberPreferencesStore((s) => s.teamDefaultLoading)
  const loadTeamDefaultAgent = useMemberPreferencesStore((s) => s.loadTeamDefaultAgent)
  const setTeamDefaultAgent = useMemberPreferencesStore((s) => s.setTeamDefaultAgent)

  const { actors } = useActorDirectory()

  // Load team default on mount / team change
  React.useEffect(() => {
    if (teamId) void loadTeamDefaultAgent(teamId)
  }, [teamId, loadTeamDefaultAgent])

  // Filter to team-visible agents only
  const teamAgents = React.useMemo(
    () => actors.filter((a) => a.actor_type === 'agent' && a.visibility === 'team'),
    [actors],
  )

  const handleChange = React.useCallback(
    async (value: string) => {
      if (!teamId) return
      const agentId = value === NONE_VALUE ? null : value
      await setTeamDefaultAgent(teamId, agentId)
    },
    [teamId, setTeamDefaultAgent],
  )

  if (!teamId) return null

  return (
    <SettingCard>
      <div className="space-y-2">
        <label className="text-[13px] font-medium flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          {t('settings.team.defaultAgent', '团队默认 Agent')}
        </label>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.team.defaultAgentDesc',
            '团队成员未设置个人默认 Agent 时，将使用此 Agent。',
          )}
        </p>

        {canManageTeam ? (
          <Select
            disabled={teamDefaultLoading}
            value={teamDefaultAgentId ?? NONE_VALUE}
            onValueChange={(v) => void handleChange(v)}
          >
            <SelectTrigger className="h-11 text-[13px]" data-testid="team-default-agent">
              <SelectValue
                placeholder={t('settings.team.defaultAgentPlaceholder', '选择团队默认 Agent（可选）')}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>
                <span className="text-muted-foreground">
                  {t('settings.team.defaultAgentPlaceholder', '选择团队默认 Agent（可选）')}
                </span>
              </SelectItem>
              {teamAgents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            {t('settings.team.defaultAgentReadOnly', '仅团队 owner/admin 可编辑')}
          </p>
        )}
      </div>
    </SettingCard>
  )
}
