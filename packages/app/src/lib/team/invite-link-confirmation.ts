import { create } from "zustand";
import { useAuthStore } from "@/stores/auth-store";

// SEC-3: an invite link is a one-click path into someone else's team — the
// claim switches the active org server-side and re-onboards the local daemon
// onto that team, and the team can then push skills into the agent's context.
// Nothing here may run on an OS-delivered URL alone: the user answers a
// confirmation dialog first, and only a token accepted in THIS app run is ever
// claimed (AuthGate checks `confirmedToken` before calling claimPendingInvite).
//
// This is deliberately not persisted. A token stashed in localStorage by a
// previous run (the signed-out deep-link path) comes back unconfirmed and is
// asked about again after sign-in.

interface InviteLinkConfirmationState {
  /** Token the dialog is currently asking about. */
  requested: string | null;
  /** The one token the user accepted in this run; AuthGate claims only this. */
  confirmedToken: string | null;
  request: (token: string) => void;
  accept: () => void;
  dismiss: () => void;
}

export const useInviteLinkConfirmation = create<InviteLinkConfirmationState>((set, get) => ({
  requested: null,
  confirmedToken: null,
  request: (token) => {
    // Already accepted this run — do not ask twice for the same link.
    if (get().confirmedToken === token) return;
    set({ requested: token });
  },
  accept: () => {
    const token = get().requested;
    if (!token) return;
    set({ requested: null, confirmedToken: token });
    // Stash it the same way the signed-out path always has. AuthGate's
    // pending-invite effect owns the claim itself: it runs now when a session
    // exists, or right after sign-in when it does not.
    useAuthStore.getState().setPendingInviteToken(token);
  },
  dismiss: () => {
    const token = get().requested;
    set({ requested: null });
    // A declined link must not come back on the next launch.
    if (token && useAuthStore.getState().pendingInviteToken === token) {
      useAuthStore.getState().setPendingInviteToken(null);
    }
  },
}));

export function requestInviteLinkConfirmation(token: string): void {
  useInviteLinkConfirmation.getState().request(token);
}

export function isInviteLinkConfirmed(token: string): boolean {
  return useInviteLinkConfirmation.getState().confirmedToken === token;
}

/**
 * Mark a token as accepted without showing the dialog. For flows where the
 * user typed or pasted the link themselves — that action already is the
 * consent the dialog exists to collect.
 */
export function confirmInviteLinkToken(token: string): void {
  useInviteLinkConfirmation.setState({ confirmedToken: token, requested: null });
}

/**
 * Run `fn` once the document has focus. A deep link can arrive while the app
 * is in the background (cold start, or a link opened from another app); acting
 * on it before the window is in front means the user never saw what happened.
 * Returns a cancel function for effect cleanup.
 */
export function whenDocumentFocused(fn: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined" || document.hasFocus()) {
    fn();
    return () => {};
  }
  const onFocus = () => {
    window.removeEventListener("focus", onFocus);
    fn();
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}

/** Test-only reset hook. */
export function resetInviteLinkConfirmationForTests(): void {
  useInviteLinkConfirmation.setState({ requested: null, confirmedToken: null });
}
