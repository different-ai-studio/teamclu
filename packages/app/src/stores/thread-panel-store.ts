import { create } from "zustand";
import { useThreadListPanelStore } from "@/stores/thread-list-panel-store";
import { useThreadSummariesStore } from "@/stores/thread-summaries-store";

export type ThreadPanelState = {
  isOpen: boolean;
  parentSessionId: string | null;
  threadSessionId: string | null;
  rootMessageId: string | null;
  title: string | null;
};

type ThreadPanelStore = ThreadPanelState & {
  open: (args: {
    parentSessionId: string;
    rootMessageId: string;
    title: string;
    threadSessionId?: string | null;
  }) => void;
  /** Hide panel; keep anchor state until exit animation calls reset(). */
  close: () => void;
  reset: () => void;
  setThreadSessionId: (threadSessionId: string) => void;
  toggle: (args: {
    parentSessionId: string;
    rootMessageId: string;
    title: string;
    threadSessionId?: string | null;
  }) => void;
};

const initial: ThreadPanelState = {
  isOpen: false,
  parentSessionId: null,
  threadSessionId: null,
  rootMessageId: null,
  title: null,
};

export const useThreadPanelStore = create<ThreadPanelStore>((set, get) => ({
  ...initial,
  open: ({ parentSessionId, threadSessionId = null, rootMessageId, title }) => {
    useThreadListPanelStore.getState().close();
    set({
      isOpen: true,
      parentSessionId,
      threadSessionId: threadSessionId ?? null,
      rootMessageId,
      title,
    });
  },
  close: () => set({ isOpen: false }),
  reset: () => set({ ...initial }),
  setThreadSessionId: (threadSessionId) => {
    const { parentSessionId, rootMessageId } = get();
    set({ threadSessionId });
    if (parentSessionId && rootMessageId) {
      useThreadSummariesStore.getState().upsertThreadSummary(parentSessionId, {
        threadSessionId,
        rootMessageId,
        messageCount: 0,
        lastMessageAt: null,
        participantCount: 0,
      });
    }
  },
  toggle: (args) => {
    const s = get();
    if (
      s.isOpen &&
      s.parentSessionId === args.parentSessionId &&
      s.rootMessageId === args.rootMessageId
    ) {
      set({ isOpen: false });
    } else {
      useThreadListPanelStore.getState().close();
      set({
        isOpen: true,
        parentSessionId: args.parentSessionId,
        threadSessionId: args.threadSessionId ?? null,
        rootMessageId: args.rootMessageId,
        title: args.title,
      });
    }
  },
}));
