import { create } from "zustand";
import { preloadSessionCreatedByActorId } from "@/lib/session/session-created-by-cache";
import { useCurrentTeamStore } from "./current-team";
import { useSessionListStore } from "./session-list-store";

type SessionSelectionState = {
  activeSessionId: string | null;
  currentSessionId: string | null;
  viewingArchivedSessionId: string | null;
  setCurrent: (sessionId: string | null) => void;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  clearActiveSession: () => void;
  setViewingArchivedSession: (sessionId: string | null) => void;
};

export const useSessionSelectionStore = create<SessionSelectionState>((set) => ({
  activeSessionId: null,
  currentSessionId: null,
  viewingArchivedSessionId: null,
  setCurrent: (sessionId) => {
    set({ activeSessionId: sessionId, currentSessionId: sessionId });
  },
  setActiveSession: async (sessionId) => {
    set({
      activeSessionId: sessionId,
      currentSessionId: sessionId,
      viewingArchivedSessionId: null,
    });
    if (sessionId) {
      const listRow = useSessionListStore.getState().rows.find((r) => r.id === sessionId);
      const teamId = listRow?.team_id ?? useCurrentTeamStore.getState().team?.id ?? null;
      preloadSessionCreatedByActorId(sessionId, teamId);
      await useSessionListStore.getState().markSessionViewed(sessionId);
    }
  },
  clearActiveSession: () => {
    set({
      activeSessionId: null,
      currentSessionId: null,
      viewingArchivedSessionId: null,
    });
  },
  setViewingArchivedSession: (sessionId) => set({ viewingArchivedSessionId: sessionId }),
}));
