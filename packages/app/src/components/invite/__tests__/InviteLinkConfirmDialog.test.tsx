import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authState } = vi.hoisted(() => ({
  authState: {
    session: null as null | { user: { id: string } },
    pendingInviteToken: null as string | null,
    setPendingInviteToken: vi.fn((token: string | null) => {
      authState.pendingInviteToken = token;
    }),
  },
}));

vi.mock("@/stores/auth-store", () => {
  const useAuthStore = (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState;
  useAuthStore.getState = () => authState;
  return { useAuthStore };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

import { InviteLinkConfirmDialog } from "../InviteLinkConfirmDialog";
import {
  requestInviteLinkConfirmation,
  resetInviteLinkConfirmationForTests,
  useInviteLinkConfirmation,
} from "@/lib/team/invite-link-confirmation";

beforeEach(() => {
  resetInviteLinkConfirmationForTests();
  authState.session = null;
  authState.pendingInviteToken = null;
  authState.setPendingInviteToken.mockClear();
});

describe("InviteLinkConfirmDialog (SEC-3)", () => {
  it("stays closed until a link asks for confirmation", () => {
    render(<InviteLinkConfirmDialog />);
    expect(screen.queryByText("Join a team from this invite link?")).not.toBeInTheDocument();
  });

  it("accepting confirms the token and stashes it for the claim", () => {
    authState.session = { user: { id: "u1" } };
    render(<InviteLinkConfirmDialog />);
    act(() => requestInviteLinkConfirmation("tok-abcdefghijklmnopqrstuvwxyz"));

    expect(screen.getByText("Join a team from this invite link?")).toBeInTheDocument();
    // Signed in: no "sign in first" hint.
    expect(screen.queryByText(/sign in first/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Join team"));
    expect(useInviteLinkConfirmation.getState().confirmedToken).toBe("tok-abcdefghijklmnopqrstuvwxyz");
    expect(useInviteLinkConfirmation.getState().requested).toBeNull();
    expect(authState.setPendingInviteToken).toHaveBeenCalledWith("tok-abcdefghijklmnopqrstuvwxyz");
  });

  it("explains the sign-in step when there is no session", () => {
    render(<InviteLinkConfirmDialog />);
    act(() => requestInviteLinkConfirmation("tok-1"));
    expect(screen.getByText(/sign in first/i)).toBeInTheDocument();
  });

  it("declining closes the dialog and clears a matching stash", () => {
    authState.pendingInviteToken = "tok-1";
    render(<InviteLinkConfirmDialog />);
    act(() => requestInviteLinkConfirmation("tok-1"));

    fireEvent.click(screen.getByText("Not now"));
    expect(useInviteLinkConfirmation.getState().requested).toBeNull();
    expect(useInviteLinkConfirmation.getState().confirmedToken).toBeNull();
    expect(authState.setPendingInviteToken).toHaveBeenCalledWith(null);
  });
});
