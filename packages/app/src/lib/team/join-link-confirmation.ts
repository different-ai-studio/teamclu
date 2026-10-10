import { create } from "zustand";
import type { ParsedJoinLink } from "@/lib/team/join-link";

// A join link is a reusable membership path. Confirmation lives in memory only:
// accepting never writes the named-invite localStorage key, and a signed-out
// accept still only sets `confirmed` for this app run.

interface JoinLinkConfirmationState {
  requested: ParsedJoinLink | null;
  confirmed: ParsedJoinLink | null;
  request: (link: ParsedJoinLink) => void;
  accept: () => void;
  dismiss: () => void;
}

function sameJoinLink(a: ParsedJoinLink | null, b: ParsedJoinLink): boolean {
  return !!a && a.token === b.token && a.cloudApiUrl === b.cloudApiUrl;
}

export const useJoinLinkConfirmation = create<JoinLinkConfirmationState>((set, get) => ({
  requested: null,
  confirmed: null,
  request: (link) => {
    if (sameJoinLink(get().confirmed, link)) return;
    set({ requested: link });
  },
  accept: () => {
    const link = get().requested;
    if (!link) return;
    set({ requested: null, confirmed: link });
  },
  dismiss: () => {
    set({ requested: null });
  },
}));

export function requestJoinLinkConfirmation(link: ParsedJoinLink): void {
  useJoinLinkConfirmation.getState().request(link);
}

export function resetJoinLinkConfirmationForTests(): void {
  useJoinLinkConfirmation.setState({ requested: null, confirmed: null });
}
