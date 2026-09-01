import { create } from "zustand";
import { useThreadPanelStore } from "@/stores/thread-panel-store";

type ThreadListPanelStore = {
  isOpen: boolean;
  parentSessionId: string | null;
  open: (parentSessionId: string) => void;
  close: () => void;
  toggle: (parentSessionId: string) => void;
  reset: () => void;
};

export const useThreadListPanelStore = create<ThreadListPanelStore>((set, get) => ({
  isOpen: false,
  parentSessionId: null,
  open: (parentSessionId) => {
    useThreadPanelStore.getState().close();
    set({ isOpen: true, parentSessionId });
  },
  close: () => set({ isOpen: false }),
  toggle: (parentSessionId) => {
    const s = get();
    if (s.isOpen && s.parentSessionId === parentSessionId) {
      set({ isOpen: false });
      return;
    }
    useThreadPanelStore.getState().close();
    set({ isOpen: true, parentSessionId });
  },
  reset: () => set({ isOpen: false, parentSessionId: null }),
}));
