import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/web-sso", () => ({
  runWebSso: vi.fn(),
  cancelWebSso: vi.fn(),
}));

import { runWebSso, cancelWebSso } from "@/lib/auth/web-sso";
import { CloudApiError } from "@/lib/backend/cloud-api/http";

const authMock = {
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  sendPhoneOtp: vi.fn(),
  verifyPhoneOtpResult: vi.fn(),
  loginWithPhoneUser: vi.fn(),
  signOut: vi.fn(),
  signInWithPassword: vi.fn(),
  claimInvite: vi.fn(),
  listPendingInvites: vi.fn(),
  acceptPendingInvite: vi.fn(),
  declinePendingInvite: vi.fn(),
  adoptSession: vi.fn(),
};
const backendMock = {
  auth: authMock,
};
const backendConfig = { hasConfig: true };
const session = {
  user: { id: "u1", email: "u1@example.com" },
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 12345,
};

const currentTeamMock = {
  // enterTeam is the only supported way in: it activates the team server-side
  // (moving the active org) before setting the client-side team.
  enterTeam: vi.fn(),
};

function storeSessionLike(userId: string) {
  return {
    user: { id: userId, email: null },
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: 99999,
  };
}


vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
  hasBackendConfig: () => backendConfig.hasConfig,
  BACKEND_CONFIG_MISSING_MESSAGE: "Supabase config missing. Configure a server before signing in.",
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamMock,
  },
}));

const { useAuthStore } = await import("./auth-store");

beforeEach(() => {
  Object.values(authMock).forEach((fn) => fn.mockReset());
  currentTeamMock.enterTeam.mockReset();
  backendConfig.hasConfig = true;
  useAuthStore.setState({
    session: null,
    loading: true,
    authFlow: "idle",
    errorMessage: null,
    otpEmail: null,
    otpPhone: null,
    pendingInviteToken: null,
  });
});

// `isAnonymous` — camelCase — is what mapSession actually produces. This fixture
// used to say `is_anonymous`, matching the production code's equally wrong
// guess, so the suite passed while every anonymous guard in the app was dead.

describe("auth-store", () => {
  it("hydrate populates session from backend auth", async () => {
    authMock.getSession.mockResolvedValueOnce(session);
    authMock.onAuthStateChange.mockImplementation(() => {});
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.user.id).toBe("u1");
    expect(useAuthStore.getState().session?.access_token).toBe("access-1");
    expect(useAuthStore.getState().session?.refresh_token).toBe("refresh-1");
    expect(useAuthStore.getState().session?.expires_at).toBe(12345);
    expect(useAuthStore.getState().loading).toBe(false);
  });

  // Cold-start login flash: a throwing getSession used to skip the
  // `set({ session, loading: false })` line entirely, leaving `loading` stuck
  // at true with `session` null. AuthGate's `.finally()` still marked auth
  // hydrated, so the gate fell through to the login screen for a user who was
  // actually signed in — and tore down the startup skeleton on the way.
  it("hydrate always settles loading, even when the backend throws", async () => {
    authMock.getSession.mockRejectedValueOnce(new Error("network down"));
    authMock.onAuthStateChange.mockImplementation(() => {});

    await expect(useAuthStore.getState().hydrate()).resolves.toBeUndefined();

    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().errorMessage).toBe("network down");
  });

  it("hydrate replaces its auth listener instead of stacking one per call", async () => {
    // StrictMode double-invokes the effect that calls hydrate, and the
    // subscription outlives it — without an unsubscribe every cold start left
    // another listener behind, each re-running bootstrap on every auth event.
    const unsubscribe = vi.fn();
    authMock.getSession.mockResolvedValue(null);
    authMock.onAuthStateChange.mockImplementation(() => unsubscribe);

    await useAuthStore.getState().hydrate();
    expect(unsubscribe).not.toHaveBeenCalled();

    await useAuthStore.getState().hydrate();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("hydrate auth listener stores token compatibility aliases", async () => {
    authMock.getSession.mockResolvedValueOnce(null);
    authMock.onAuthStateChange.mockImplementation((listener) => {
      listener({
        user: { id: "u-listener", email: "listener@example.com" },
        accessToken: "access-listener",
        refreshToken: "refresh-listener",
        expiresAt: 67890,
      });
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session).toMatchObject({
      user: { id: "u-listener" },
      accessToken: "access-listener",
      refreshToken: "refresh-listener",
      expiresAt: 67890,
      access_token: "access-listener",
      refresh_token: "refresh-listener",
      expires_at: 67890,
    });
  });

  it("sendOtp stashes email and returns true on success", async () => {
    authMock.sendOtp.mockResolvedValueOnce(undefined);
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(true);
    expect(authMock.sendOtp).toHaveBeenCalledWith("a@b.com");
    expect(useAuthStore.getState().otpEmail).toBe("a@b.com");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("sendOtp captures error and returns false on failure", async () => {
    authMock.sendOtp.mockRejectedValueOnce(new Error("rate limit"));
    const ok = await useAuthStore.getState().sendOtp("a@b.com");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe("rate limit");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("sendOtp returns a config error without calling Supabase when config is missing", async () => {
    backendConfig.hasConfig = false;

    const ok = await useAuthStore.getState().sendOtp("a@b.com");

    expect(ok).toBe(false);
    expect(authMock.sendOtp).not.toHaveBeenCalled();
    expect(useAuthStore.getState().errorMessage).toMatch(/Supabase config missing/);
  });

  it("verifyOtp sets session on success", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    authMock.verifyOtp.mockResolvedValueOnce({ user: { id: "u2" } });
    await useAuthStore.getState().verifyOtp("123456");
    expect(authMock.verifyOtp).toHaveBeenCalledWith("a@b.com", "123456");
    expect(useAuthStore.getState().session?.user.id).toBe("u2");
    expect(useAuthStore.getState().otpEmail).toBeNull();
  });

  it("verifyOtp captures error message on failure", async () => {
    useAuthStore.setState({ otpEmail: "a@b.com" });
    authMock.verifyOtp.mockRejectedValueOnce(new Error("Invalid code"));
    await useAuthStore.getState().verifyOtp("000000");
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().errorMessage).toBe("Invalid code");
  });

  it("verifyOtp errors when no pending email", async () => {
    await useAuthStore.getState().verifyOtp("123456");
    expect(useAuthStore.getState().errorMessage).toMatch(/No pending sign-in/);
  });

  it("sendPhoneOtp stashes phone and returns true on success", async () => {
    authMock.sendPhoneOtp.mockResolvedValueOnce(undefined);
    const ok = await useAuthStore.getState().sendPhoneOtp("+8613800138000");
    expect(ok).toBe(true);
    expect(authMock.sendPhoneOtp).toHaveBeenCalledWith("+8613800138000");
    expect(useAuthStore.getState().otpPhone).toBe("+8613800138000");
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  it("sendPhoneOtp captures error and returns false on failure", async () => {
    authMock.sendPhoneOtp.mockRejectedValueOnce(new Error("sms rate limit"));
    const ok = await useAuthStore.getState().sendPhoneOtp("+8613800138000");
    expect(ok).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe("sms rate limit");
    expect(useAuthStore.getState().otpPhone).toBeNull();
  });

  it("verifyPhoneOtp sets session on success", async () => {
    useAuthStore.setState({ otpPhone: "+8613800138000" });
    authMock.verifyPhoneOtpResult.mockResolvedValueOnce({
      type: "session",
      session: storeSessionLike("p2"),
    });
    await useAuthStore.getState().verifyPhoneOtp("123456");
    expect(authMock.verifyPhoneOtpResult).toHaveBeenCalledWith("+8613800138000", "123456");
    expect(useAuthStore.getState().session?.user.id).toBe("p2");
    expect(useAuthStore.getState().otpPhone).toBeNull();
  });

  it("verifyPhoneOtp errors when no pending phone", async () => {
    await useAuthStore.getState().verifyPhoneOtp("123456");
    expect(useAuthStore.getState().errorMessage).toMatch(/No pending sign-in/);
  });

  it("signOut clears session and pending otp", async () => {
    useAuthStore.setState({ session: { user: { id: "u" } }, otpEmail: "a@b.com", otpPhone: "+8613800138000" });
    authMock.signOut.mockResolvedValueOnce(undefined);
    await useAuthStore.getState().signOut();
    expect(authMock.signOut).toHaveBeenCalled();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().otpEmail).toBeNull();
    expect(useAuthStore.getState().otpPhone).toBeNull();
  });



  it("signInWithPassword stores the returned session", async () => {
    authMock.signInWithPassword.mockResolvedValueOnce(storeSessionLike("password-1"));

    const ok = await useAuthStore.getState().signInWithPassword("person@example.com", "password123");

    expect(ok).toBe(true);
    expect(authMock.signInWithPassword).toHaveBeenCalledWith("person@example.com", "password123");
    expect(useAuthStore.getState().session?.user.id).toBe("password-1");
  });

  it("claimInvite claims the token through backend auth", async () => {
    authMock.claimInvite.mockResolvedValueOnce({
      actorId: "actor-1",
      teamId: "team-1",
      actorType: "member",
      displayName: "Alice",
      refreshToken: null,
    });

    const result = await useAuthStore.getState().claimInvite("tok-1");

    expect(authMock.claimInvite).toHaveBeenCalledWith("tok-1");
    expect(result?.teamId).toBe("team-1");
  });

  it("setPendingInviteToken stores the token", () => {
    useAuthStore.getState().setPendingInviteToken("tok-2");
    expect(useAuthStore.getState().pendingInviteToken).toBe("tok-2");
  });


  it("claimPendingInvite drops a token the server permanently rejects", async () => {
    // 400 validation_failed is what `claim_team_invite` raising 'invite already
    // consumed' / 'invite expired' / 'already a member of this team' becomes.
    // Keeping such a token made AuthGate skip team bootstrap on every launch.
    authMock.claimInvite.mockRejectedValueOnce(
      new CloudApiError(400, "validation_failed", "invite already consumed", null),
    );
    useAuthStore.setState({ session: storeSessionLike("real-5"), pendingInviteToken: "tok-5" });

    const result = await useAuthStore.getState().claimPendingInvite();

    expect(result).toBeNull();
    expect(useAuthStore.getState().pendingInviteToken).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().authFlow).toBe("idle");
  });

  it("claimPendingInvite keeps the token when the failure is transient", async () => {
    authMock.claimInvite.mockRejectedValueOnce(new Error("network down"));
    useAuthStore.setState({ session: storeSessionLike("real-6"), pendingInviteToken: "tok-6" });

    const result = await useAuthStore.getState().claimPendingInvite();

    expect(result).toBeNull();
    expect(useAuthStore.getState().pendingInviteToken).toBe("tok-6");
  });

  it("claimPendingInvite claims and enters the team for a real session", async () => {
    authMock.claimInvite.mockResolvedValueOnce({
      actorId: "actor-4",
      teamId: "team-4",
      actorType: "member",
      displayName: "Dana",
      refreshToken: null,
    });
    useAuthStore.setState({ session: storeSessionLike("real-4"), pendingInviteToken: "tok-4" });

    const result = await useAuthStore.getState().claimPendingInvite();

    expect(authMock.claimInvite).toHaveBeenCalledWith("tok-4");
    expect(currentTeamMock.enterTeam).toHaveBeenCalledWith("team-4");
    expect(result?.teamId).toBe("team-4");
    expect(useAuthStore.getState().pendingInviteToken).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().authFlow).toBe("idle");
  });

  const pendingInvite = {
    inviteId: "invite-1",
    teamId: "team-7",
    teamName: "Team Seven",
    teamRole: "member",
    displayName: "Erin",
    invitedByDisplayName: "Dana",
    inviteEmail: "erin@example.com",
    invitePhone: null,
    expiresAt: "2026-08-01T00:00:00Z",
    matchedVia: "email" as const,
  };


  it("refreshPendingInvites stores matched invites for a real session", async () => {
    authMock.listPendingInvites.mockResolvedValueOnce([pendingInvite]);
    useAuthStore.setState({ session: storeSessionLike("real-7"), pendingInvites: [] });

    await useAuthStore.getState().refreshPendingInvites();

    expect(useAuthStore.getState().pendingInvites).toEqual([pendingInvite]);
    expect(useAuthStore.getState().pendingInvitesLoading).toBe(false);
  });

  it("refreshPendingInvites swallows a lookup failure (must not break a good sign-in)", async () => {
    authMock.listPendingInvites.mockRejectedValueOnce(new Error("network down"));
    useAuthStore.setState({ session: storeSessionLike("real-8"), pendingInvites: [], errorMessage: null });

    await useAuthStore.getState().refreshPendingInvites();

    // Deliberately silent: the user can still join via a link, and surfacing
    // this would put an error banner on an otherwise successful login.
    expect(useAuthStore.getState().errorMessage).toBeNull();
    expect(useAuthStore.getState().pendingInvitesLoading).toBe(false);
  });

  it("acceptPendingInvite enters the team and drops the invite from the list", async () => {
    authMock.acceptPendingInvite.mockResolvedValueOnce({
      actorId: "actor-7",
      teamId: "team-7",
      actorType: "member",
      displayName: "Erin",
      refreshToken: null,
    });
    useAuthStore.setState({ session: storeSessionLike("real-9"), pendingInvites: [pendingInvite] });

    const result = await useAuthStore.getState().acceptPendingInvite("invite-1");

    expect(authMock.acceptPendingInvite).toHaveBeenCalledWith("invite-1");
    expect(currentTeamMock.enterTeam).toHaveBeenCalledWith("team-7");
    expect(result?.teamId).toBe("team-7");
    expect(useAuthStore.getState().pendingInvites).toEqual([]);
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().authFlow).toBe("idle");
  });

  it("acceptPendingInvite keeps the invite listed when the accept fails", async () => {
    authMock.acceptPendingInvite.mockRejectedValueOnce(new Error("invite expired"));
    useAuthStore.setState({ session: storeSessionLike("real-10"), pendingInvites: [pendingInvite] });

    const result = await useAuthStore.getState().acceptPendingInvite("invite-1");

    expect(result).toBeNull();
    expect(currentTeamMock.enterTeam).not.toHaveBeenCalled();
    expect(useAuthStore.getState().pendingInvites).toEqual([pendingInvite]);
    expect(useAuthStore.getState().errorMessage).toBe("invite expired");
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("declinePendingInvite drops the invite without entering any team", async () => {
    authMock.declinePendingInvite.mockResolvedValueOnce(undefined);
    useAuthStore.setState({ session: storeSessionLike("real-11"), pendingInvites: [pendingInvite] });

    const ok = await useAuthStore.getState().declinePendingInvite("invite-1");

    expect(ok).toBe(true);
    expect(authMock.declinePendingInvite).toHaveBeenCalledWith("invite-1");
    expect(currentTeamMock.enterTeam).not.toHaveBeenCalled();
    expect(useAuthStore.getState().pendingInvites).toEqual([]);
  });




  it("claimPendingInvite keeps the token for retry when the claim fails", async () => {
    authMock.claimInvite.mockRejectedValueOnce(new Error("Invite expired"));
    useAuthStore.setState({ session: storeSessionLike("real-3"), pendingInviteToken: "expired" });

    const result = await useAuthStore.getState().claimPendingInvite();

    expect(result).toBeNull();
    expect(useAuthStore.getState().pendingInviteToken).toBe("expired");
    expect(useAuthStore.getState().authFlow).toBe("idle");
    expect(useAuthStore.getState().errorMessage).toBe("Invite expired");
  });
});

describe("signInWithWebSso", () => {
  it("adopts the harvested refresh token and sets the session", async () => {
    (runWebSso as ReturnType<typeof vi.fn>).mockResolvedValue("RT");
    const adopted = { accessToken: "AT", refreshToken: "RT", user: { id: "u1" } };
    authMock.adoptSession.mockResolvedValue(adopted);
    const ok = await useAuthStore.getState().signInWithWebSso();
    expect(ok).toBe(true);
    expect(authMock.adoptSession).toHaveBeenCalledWith("RT");
    expect(useAuthStore.getState().session?.access_token).toBe("AT");
    expect(useAuthStore.getState().webSsoPending).toBe(false);
  });

  it("resets pending without an error message when cancelled", async () => {
    (runWebSso as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("cancelled"), { code: "websso_cancelled" }),
    );
    const ok = await useAuthStore.getState().signInWithWebSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().webSsoPending).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBeNull();
  });

  // A failing `invoke()` rejects with the command's `Err(String)` payload — a
  // bare string, not an Error. Surfacing it is the whole point: the generic
  // fallback is what hid a Windows webview pre-flight rejection behind
  // "Authentication failed." with no way to tell which host or why.
  it("surfaces a native string rejection instead of the generic fallback", async () => {
    (runWebSso as ReturnType<typeof vi.fn>).mockRejectedValue(
      "Host 'admin.example.com' is not reachable: error trying to connect",
    );
    const ok = await useAuthStore.getState().signInWithWebSso();
    expect(ok).toBe(false);
    expect(useAuthStore.getState().webSsoPending).toBe(false);
    expect(useAuthStore.getState().errorMessage).toBe(
      "Host 'admin.example.com' is not reachable: error trying to connect",
    );
  });

  it("still falls back for a rejection that carries no message", async () => {
    (runWebSso as ReturnType<typeof vi.fn>).mockRejectedValue("   ");
    await useAuthStore.getState().signInWithWebSso();
    expect(useAuthStore.getState().errorMessage).toBe("Authentication failed.");
  });

  it("cancelWebSso delegates to the lib", () => {
    useAuthStore.setState({ webSsoPending: true });
    useAuthStore.getState().cancelWebSso();
    expect(cancelWebSso).toHaveBeenCalled();
  });
});
