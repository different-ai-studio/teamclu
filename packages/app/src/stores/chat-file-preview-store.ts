import { create } from "zustand";
import type { SidebarPreviewKind } from "@/lib/messages/chat-open-target";

export type ChatPreviewTab = {
  id: string;
  name: string;
  kind: SidebarPreviewKind;
  path?: string;
  text?: string;
};

type ChatFilePreviewState = {
  tabs: ChatPreviewTab[];
  activeId: string | null;
  collapsed: boolean;
  width: number;
  openTab: (tab: ChatPreviewTab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  toggleCollapsed: () => void;
  setWidth: (width: number) => void;
};

export const useChatFilePreviewStore = create<ChatFilePreviewState>((set) => ({
  tabs: [],
  activeId: null,
  collapsed: false,
  width: 420,
  openTab: (tab) =>
    set((state) => {
      const exists = state.tabs.some((item) => item.id === tab.id);
      return {
        tabs: exists
          ? state.tabs.map((item) => (item.id === tab.id ? { ...item, ...tab } : item))
          : [...state.tabs, tab],
        activeId: tab.id,
        collapsed: false,
      };
    }),
  closeTab: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((item) => item.id !== id);
      const activeId =
        state.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : state.activeId;
      return { tabs, activeId, collapsed: tabs.length === 0 ? false : state.collapsed };
    }),
  setActive: (id) => set({ activeId: id, collapsed: false }),
  toggleCollapsed: () =>
    set((state) => ({ collapsed: state.tabs.length > 0 ? !state.collapsed : false })),
  setWidth: (width) => set({ width }),
}));
