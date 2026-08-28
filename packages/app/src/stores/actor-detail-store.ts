import { create } from 'zustand'
import { useCurrentTeamStore } from '@/stores/current-team'
import { useUIStore } from '@/stores/ui'

/**
 * What the main content column shows while the Contacts section is active.
 * Mirrors idea-detail: contacts never create tabs — the selected profile
 * renders directly beside the list column.
 */
interface ActorDetailState {
  actorId: string | null
  openActor: (actorId: string) => void
  clearDetail: () => void
}

export const useActorDetailStore = create<ActorDetailState>((set) => ({
  actorId: null,
  openActor: (actorId) => set({ actorId }),
  clearDetail: () => set({ actorId: null }),
}))

useCurrentTeamStore.subscribe((state, prev) => {
  if (state.team?.id !== prev.team?.id) {
    useActorDetailStore.getState().clearDetail()
  }
})

useUIStore.subscribe((state, prev) => {
  if (prev.sidebarFilter.kind === 'actors' && state.sidebarFilter.kind !== 'actors') {
    useActorDetailStore.getState().clearDetail()
  }
})
