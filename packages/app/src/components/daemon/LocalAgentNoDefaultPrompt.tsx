import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'
import { useMemberPreferencesStore } from '@/stores/member-preferences-store'
import { isTauri } from '@/lib/utils'

const TOAST_ID = 'local-agent-no-default'

/**
 * Offer the local Agent when the team's defaults are cleared from inside the
 * app (#1678).
 *
 * Entering a team with no default enables the local Agent outright; once in, a
 * default that goes away is only an offer — a toast that stays until it is
 * acted on, never a runtime download behind the user's back. A default that
 * comes back (set here, by an admin, from another device) withdraws the offer.
 *
 * Renders nothing itself.
 */
export function LocalAgentNoDefaultPrompt() {
  const { t } = useTranslation()
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const enabled = useDaemonOnboardingStore((s) => s.enabled)
  const memberDefault = useMemberPreferencesStore((s) => s.defaultAgentId)
  const teamDefault = useMemberPreferencesStore((s) => s.teamDefaultAgentId)
  const effectiveTeamId = useMemberPreferencesStore((s) => s.effectiveDefaultTeamId)
  const effectiveLoading = useMemberPreferencesStore((s) => s.effectiveDefaultLoading)
  const effective = useMemberPreferencesStore((s) => s.effectiveDefaultAgentId)
  const loadEffective = useMemberPreferencesStore((s) => s.loadEffectiveDefaultAgent)

  // Either default changing in this window changes the effective one; the
  // store only re-reads it when asked.
  const seenDefaults = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!isTauri() || !teamId || enabled !== false) return
    const key = `${teamId}|${memberDefault ?? ''}|${teamDefault ?? ''}`
    if (seenDefaults.current === null) {
      seenDefaults.current = key
      return
    }
    if (seenDefaults.current === key) return
    seenDefaults.current = key
    void loadEffective(teamId)
  }, [teamId, enabled, memberDefault, teamDefault, loadEffective])

  const offer =
    isTauri() &&
    enabled === false &&
    !!teamId &&
    effectiveTeamId === teamId &&
    !effectiveLoading &&
    !effective

  React.useEffect(() => {
    if (!offer) {
      toast.dismiss(TOAST_ID)
      return
    }
    toast(t('localAgent.noDefaultTitle', 'No default agent'), {
      id: TOAST_ID,
      duration: Infinity,
      description: t(
        'localAgent.noDefaultHint',
        'New chats have no agent to go to. Enable the agent on this computer, or set a default agent.',
      ),
      action: {
        label: t('localAgent.enableAction', 'Enable'),
        onClick: () => {
          void import('@/lib/daemon/local-agent-gate').then(({ ensureLocalAgentEnabled }) =>
            ensureLocalAgentEnabled({ skipIntro: true }),
          )
        },
      },
    })
  }, [offer, t])

  React.useEffect(() => () => void toast.dismiss(TOAST_ID), [])

  return null
}
