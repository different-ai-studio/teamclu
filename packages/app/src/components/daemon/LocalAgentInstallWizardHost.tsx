import { DaemonOnboardingWizard } from '@/components/auth/DaemonOnboardingWizard'
import { refreshAfterLocalAgentInstall } from '@/lib/daemon/local-agent-install'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useLocalAgentInstallStore } from '@/stores/local-agent-install'

/** Mounts the existing install wizard only after the user opens the card. */
export function LocalAgentInstallWizardHost() {
  const open = useLocalAgentInstallStore((s) => s.wizardOpen)
  const closeWizard = useLocalAgentInstallStore((s) => s.closeWizard)
  const teamId = useCurrentTeamStore((s) => s.team?.id ?? null)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <DaemonOnboardingWizard
        onDone={() => {
          closeWizard()
          const id = teamId?.trim()
          if (!id) return
          void refreshAfterLocalAgentInstall(id)
        }}
      />
    </div>
  )
}
