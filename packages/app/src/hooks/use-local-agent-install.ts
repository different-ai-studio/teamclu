import { useCurrentTeamStore } from '@/stores/current-team'
import {
  useLocalAgentInstallStore,
  type LocalAgentInstallStatus,
} from '@/stores/local-agent-install'

export type LocalAgentSectionGate = 'show' | 'card' | 'wait'

/** `card` replaces a local-agent surface. `wait` means classification is in flight. */
export function useLocalAgentSectionGate(): LocalAgentSectionGate {
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  const status = useLocalAgentInstallStore((s) =>
    teamId ? s.byTeam[teamId]?.status : undefined,
  )
  return gateFor(status)
}

export function useLocalAgentAbsent(): boolean {
  return useLocalAgentSectionGate() === 'card'
}

function gateFor(status: LocalAgentInstallStatus | undefined): LocalAgentSectionGate {
  if (status === 'pending') return 'wait'
  if (status === 'absent') return 'card'
  return 'show'
}
