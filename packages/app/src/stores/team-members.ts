// packages/app/src/stores/team-members.ts
import { create } from 'zustand'

// Local-identity store. Team roles/members now come from the cloud team
// (useCurrentTeamStore + useTeamPermissions); the legacy git-manifest member
// system was removed. This store tracks the local daemon's actor_id, used by
// the env-vars store to scope per-actor team env writes. (`get_device_info`
// was deleted — device_id == actor_id, sourced from the daemon's /v1/info.)
interface DeviceIdentityState {
  /** This machine's daemon actor_id, loaded once and shared across components. */
  currentNodeId: string | null
  loadCurrentNodeId: () => Promise<void>
  reset: () => void
}

export const useTeamMembersStore = create<DeviceIdentityState>((set, get) => ({
  currentNodeId: null,

  loadCurrentNodeId: async () => {
    if (get().currentNodeId) return
    try {
      const { getLocalDaemonActorId } = await import('@/lib/daemon/daemon-agent-admin')
      const actorId = await getLocalDaemonActorId()
      if (actorId) set({ currentNodeId: actorId })
    } catch {
      // Local identity can be unavailable during early startup (daemon not yet
      // running / onboarded); retry next call.
    }
  },

  reset: () => set({ currentNodeId: null }),
}))
