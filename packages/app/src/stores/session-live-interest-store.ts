import { create } from "zustand";
import { noteInboxOpenedSession } from "@/lib/session-live-subscriptions";

type SessionLiveInterestStore = {
  /** Bumps when a session is opened for live interest (triggers MQTT resync). */
  revision: number;
  /** Mark session for idle live SUB — same 1h policy as inbox-opened main sessions. */
  noteSessionOpened: (sessionId: string) => void;
};

export const useSessionLiveInterestStore = create<SessionLiveInterestStore>((set) => ({
  revision: 0,
  noteSessionOpened: (sessionId) => {
    const trimmed = sessionId.trim();
    if (!trimmed) return;
    noteInboxOpenedSession(trimmed);
    set((s) => ({ revision: s.revision + 1 }));
  },
}));
