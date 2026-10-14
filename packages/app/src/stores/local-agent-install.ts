import { create } from 'zustand'

/** Whether this account has a local agent bound to this team on this machine. */
export type LocalAgentInstallStatus = 'pending' | 'installed' | 'absent' | 'unknown'

export type LocalAgentInstallRecord = {
  status: LocalAgentInstallStatus
  agentId: string | null
  displayName: string | null
}

type LocalAgentInstallState = {
  byTeam: Record<string, LocalAgentInstallRecord>
  wizardOpen: boolean
  /** Team whose full-screen install gate was skipped. Later wizard progress must not pull that gate back over the shell. */
  gateSkippedTeamId: string | null
  openWizard: () => void
  closeWizard: () => void
}

export const useLocalAgentInstallStore = create<LocalAgentInstallState>((set) => ({
  byTeam: {},
  wizardOpen: false,
  gateSkippedTeamId: null,
  openWizard: () => set({ wizardOpen: true }),
  closeWizard: () => set({ wizardOpen: false }),
}))

/** Mark a team as still being classified, before the first await that yields. */
export function markLocalAgentInstallPending(teamId: string): void {
  const id = teamId.trim()
  if (!id) return
  const current = useLocalAgentInstallStore.getState().byTeam[id]
  // A finished classification must not be wiped by a second caller that
  // marks pending before awaiting the shared promise.
  if (current && current.status !== 'pending') return
  useLocalAgentInstallStore.setState((state) => ({
    byTeam: {
      ...state.byTeam,
      [id]: { status: 'pending', agentId: null, displayName: null },
    },
  }))
}

export function publishLocalAgentInstall(teamId: string, record: LocalAgentInstallRecord): void {
  const id = teamId.trim()
  if (!id) return
  useLocalAgentInstallStore.setState((state) => ({
    byTeam: { ...state.byTeam, [id]: record },
  }))
  // Bootstrap may have saved the broker while classification was still
  // pending, so the "address arrived" reconnect did not run. Becoming absent
  // is the other moment the desktop client has to own the connection.
  if (record.status === 'absent') {
    void import('@/stores/mqtt-reconnect')
      .then((m) => m.reconnectDesktopMqttWhenLocalAgentAbsent())
      .catch(() => undefined)
  }
}
