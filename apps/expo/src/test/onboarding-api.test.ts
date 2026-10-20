import { describe, expect, it, vi } from "vitest";

import type { BootstrapResult, TeamSummary } from "../features/onboarding/onboarding-types";

function makeClient(overrides: {
  session?: { user: { id: string; is_anonymous?: boolean; email?: string | null } } | null;
  get?: ReturnType<typeof vi.fn>;
  post?: ReturnType<typeof vi.fn>;
  auth?: Record<string, unknown>;
}) {
  const session = overrides.session === undefined ? null : overrides.session;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session } }),
      setRefreshSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
      ...overrides.auth,
    },
    api: {
      get: overrides.get ?? vi.fn(),
      post: overrides.post ?? vi.fn(),
    },
  } as never;
}

describe("createOnboardingApi (cloud-only)", () => {
  it("loadBootstrap returns null team when the session is anonymous with no teams", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({ items: [] });
    const client = makeClient({
      session: { user: { id: "user-1", is_anonymous: true } },
      get,
    });

    const api = createOnboardingApi(client);
    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: true,
      team: null,
      memberActorId: null,
      teamChoices: [],
    } satisfies BootstrapResult);
    expect(get).toHaveBeenCalledWith("/v1/teams?scope=all");
  });

  it("loadBootstrap activates the only team and resolves its actor", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({
      items: [{ id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" }],
    });
    const post = vi.fn().mockResolvedValue({ actorId: "actor-1", refreshToken: "refresh-1" });
    const setRefreshSession = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = makeClient({ session: { user: { id: "user-1", is_anonymous: false } }, get, post, auth: { setRefreshSession } });

    const api = createOnboardingApi(client);
    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: false,
      memberActorId: "actor-1",
      team: { id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" } satisfies TeamSummary,
      teamChoices: [],
    } satisfies BootstrapResult);
    expect(post).toHaveBeenCalledWith("/v1/teams/team-1/activate");
    expect(setRefreshSession).toHaveBeenCalledWith("refresh-1");
  });

  it("loadBootstrap stops to ask when the user is on more than one team", async () => {
    // It used to take the first listed team and activate it, so a user on
    // several landed in one with nothing saying a choice had been made.
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({
      items: [
        { id: "team-1", name: "Alpha", slug: "alpha", role: "owner", orgName: "Acme" },
        { id: "team-2", name: "Beta", slug: "beta", role: "member" },
      ],
    });
    const post = vi.fn();
    const client = makeClient({ session: { user: { id: "user-1", is_anonymous: false } }, get, post });

    const api = createOnboardingApi(client);
    const result = await api.loadBootstrap();

    expect(result.team).toBeNull();
    expect(result.teamChoices.map((t) => t.id)).toEqual(["team-1", "team-2"]);
    expect(result.teamChoices[0]?.orgName).toBe("Acme");
    // Nothing is activated yet: doing so would put the session in an org the
    // user may be about to navigate away from.
    expect(post).not.toHaveBeenCalled();
  });

  it("loadBootstrap honours a remembered team without asking", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({
      items: [
        { id: "team-1", name: "Alpha", slug: "alpha", role: "owner" },
        { id: "team-2", name: "Beta", slug: "beta", role: "member" },
      ],
    });
    const post = vi.fn().mockResolvedValue({ actorId: "actor-2", refreshToken: "" });
    const client = makeClient({ session: { user: { id: "user-1", is_anonymous: false } }, get, post });

    const api = createOnboardingApi(client);
    const result = await api.loadBootstrap("team-2");

    expect(result.team?.id).toBe("team-2");
    expect(result.teamChoices).toEqual([]);
    expect(post).toHaveBeenCalledWith("/v1/teams/team-2/activate");
  });

  it("loadBootstrap asks again when the remembered team is gone", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({
      items: [
        { id: "team-1", name: "Alpha", slug: "alpha", role: "owner" },
        { id: "team-2", name: "Beta", slug: "beta", role: "member" },
      ],
    });
    const post = vi.fn();
    const client = makeClient({ session: { user: { id: "user-1", is_anonymous: false } }, get, post });

    const api = createOnboardingApi(client);
    const result = await api.loadBootstrap("team-removed");

    expect(result.team).toBeNull();
    expect(result.teamChoices).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  it("loadBootstrap returns empty when there is no session", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const client = makeClient({ session: null });
    const api = createOnboardingApi(client);
    await expect(api.loadBootstrap()).resolves.toEqual({
      isAnonymous: false,
      team: null,
      memberActorId: null,
      teamChoices: [],
    } satisfies BootstrapResult);
  });

  it("sendEmailOTP requests an OTP and returns the pending email", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const signInWithOtp = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ auth: { signInWithOtp } });
    const api = createOnboardingApi(client);

    await expect(api.sendEmailOTP("person@example.com")).resolves.toEqual({
      pendingEmail: "person@example.com",
    });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      options: { shouldCreateUser: true },
    });
  });

  it("verifyOTP delegates to the auth client with email type", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const verifyOtp = vi.fn().mockResolvedValue({});
    const client = makeClient({ auth: { verifyOtp } });
    const api = createOnboardingApi(client);

    await api.verifyOTP("person@example.com", "123456");
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      token: "123456",
      type: "email",
    });
  });

  it("createOAuthSignInUrl builds the PKCE authorize URL", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const oauthAuthorize = vi
      .fn()
      .mockResolvedValue("https://fc.example.com/v1/auth/oauth/google/authorize?...");
    const client = makeClient({ auth: { oauthAuthorize } });
    const api = createOnboardingApi(client);

    await expect(
      api.createOAuthSignInUrl("google", "teamclu://auth-callback"),
    ).resolves.toBe("https://fc.example.com/v1/auth/oauth/google/authorize?...");
    expect(oauthAuthorize).toHaveBeenCalledWith("google", "teamclu://auth-callback");
  });

  it("completeOAuthCallback exchanges a PKCE code", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const exchangeOAuthCode = vi.fn().mockResolvedValue({});
    const client = makeClient({ auth: { exchangeOAuthCode } });
    const api = createOnboardingApi(client);

    await api.completeOAuthCallback("teamclu://auth-callback?code=abc");
    expect(exchangeOAuthCode).toHaveBeenCalledWith("abc");
  });

  it("completeOAuthCallback stores implicit token callbacks", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const setSession = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = makeClient({ auth: { setSession } });
    const api = createOnboardingApi(client);

    await api.completeOAuthCallback(
      "teamclu://auth-callback#access_token=access&refresh_token=refresh",
    );
    expect(setSession).toHaveBeenCalledWith({
      access_token: "access",
      refresh_token: "refresh",
    });
  });

  it("createTeam posts to /v1/teams then resolves its role from the team list", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const post = vi.fn().mockResolvedValue({ id: "team-1", name: "Team Claw", slug: "team-claw" });
    const get = vi.fn().mockResolvedValue({
      items: [{ id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" }],
    });
    const client = makeClient({ post, get });
    const api = createOnboardingApi(client);

    await expect(api.createTeam("Team Claw")).resolves.toEqual({
      id: "team-1",
      name: "Team Claw",
      slug: "team-claw",
      role: "owner",
    } satisfies TeamSummary);
    expect(post).toHaveBeenCalledWith("/v1/teams", { name: "Team Claw" });
    expect(get).toHaveBeenCalledWith("/v1/teams");
  });

  it("loadBootstrap narrows to the signed-in identity's home org (#1585)", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({
      homeOrgId: "org-gym",
      items: [
        { id: "t-betly", name: "Betly", orgId: "org-betly", orgName: "Betly" },
        { id: "t-gym", name: "Gym", orgId: "org-gym", orgName: "Gym" },
      ],
    });
    const post = vi.fn().mockResolvedValue({ actorId: "actor-9", refreshToken: "" });
    const client = makeClient({ session: { user: { id: "user-1" } }, get, post });

    const result = await createOnboardingApi(client).loadBootstrap();
    expect(result.team?.id).toBe("t-gym");
    expect(post).toHaveBeenCalledWith("/v1/teams/t-gym/activate");
  });

  it("phone verify and account login go through the auth client", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const phoneLogin = vi
      .fn()
      .mockResolvedValueOnce({ type: "multiUser", accounts: [] })
      .mockResolvedValueOnce({ type: "session", session: {} });
    const phoneSendCode = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ auth: { phoneLogin, phoneSendCode } });
    const api = createOnboardingApi(client);

    await expect(api.sendPhoneOTP("+86138")).resolves.toEqual({ pendingPhone: "+86138" });
    expect(phoneSendCode).toHaveBeenCalledWith("+86138");
    await expect(api.verifyPhoneOTP("+86138", "123456")).resolves.toEqual({
      type: "multiUser",
      accounts: [],
    });
    expect(phoneLogin).toHaveBeenLastCalledWith({ phone: "+86138", code: "123456" });
    await api.loginWithPhoneAccount("+86138", "123456", "u2");
    expect(phoneLogin).toHaveBeenLastCalledWith({ phone: "+86138", code: "123456", userId: "u2" });
  });

  it("loginWithPhoneAccount fails when the server asks again instead of signing in", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const phoneLogin = vi.fn().mockResolvedValue({ type: "multiUser", accounts: [] });
    const api = createOnboardingApi(makeClient({ auth: { phoneLogin } }));
    await expect(api.loginWithPhoneAccount("+86138", "1", "u")).rejects.toThrow();
  });

  it("claimInvite posts the token and adopts the minted session", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const post = vi.fn().mockResolvedValue({ actorId: "a", teamId: "t-1", refreshToken: "rt" });
    const setRefreshSession = vi.fn().mockResolvedValue({ data: {}, error: null });
    const api = createOnboardingApi(makeClient({ post, auth: { setRefreshSession } }));

    await expect(api.claimInvite("  tok ")).resolves.toBe("t-1");
    expect(post).toHaveBeenCalledWith("/v1/invites/claim", { token: "tok" });
    expect(setRefreshSession).toHaveBeenCalledWith("rt");
  });

  it("acceptPendingInvite posts to the invite's accept route", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const post = vi.fn().mockResolvedValue({ actorId: "a", teamId: "t-2", refreshToken: null });
    const setRefreshSession = vi.fn();
    const api = createOnboardingApi(makeClient({ post, auth: { setRefreshSession } }));

    await expect(api.acceptPendingInvite("inv 1")).resolves.toBe("t-2");
    expect(post).toHaveBeenCalledWith("/v1/invites/inv%201/accept", {});
    expect(setRefreshSession).not.toHaveBeenCalled();
  });

  it("listPendingInvites and hasAnyTeam read without side effects", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn(async (path: string) =>
      path === "/v1/invites/pending"
        ? { items: [{ inviteId: "i", teamId: "t" }] }
        : { items: [{ id: "t", name: "T", isMember: false }] },
    );
    const post = vi.fn();
    const api = createOnboardingApi(makeClient({ get, post }));

    await expect(api.listPendingInvites()).resolves.toHaveLength(1);
    await expect(api.hasAnyTeam()).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
