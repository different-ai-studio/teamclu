import { describe, expect, it, vi } from "vitest";

import type {
  BootstrapResult,
  OnboardingState,
} from "../features/onboarding/onboarding-types";

// signOut clears the device-cached MQTT broker, which reaches AsyncStorage.
// Backing the mock with a real map rather than no-ops lets the sign-out test
// assert the entry is actually gone instead of that a function was called.
const storageMock = vi.hoisted(() => {
  const items = new Map<string, string>();
  return {
    items,
    api: {
      getItem: async (key: string) => items.get(key) ?? null,
      setItem: async (key: string, value: string) => void items.set(key, value),
      removeItem: async (key: string) => void items.delete(key),
    },
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storageMock.api,
}));
type OnboardingApi = ReturnType<
  (typeof import("../lib/supabase/onboarding-api"))["createOnboardingApi"]
>;

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createApiMock(overrides: Partial<OnboardingApi> = {}): OnboardingApi {
  return {
    getCurrentSession: vi.fn().mockResolvedValue(null),
    activateTeam: vi.fn().mockResolvedValue("actor-1"),
    adoptRefreshSession: vi.fn().mockResolvedValue(undefined),
    loadBootstrap: vi.fn().mockResolvedValue({
      isAnonymous: false,
      team: null,
      memberActorId: null,
        teamChoices: [],
    } satisfies BootstrapResult),
    sendEmailOTP: vi.fn().mockImplementation(async (email: string) => ({
      pendingEmail: email,
    })),
    verifyOTP: vi.fn().mockResolvedValue({}),
    signInWithPassword: vi.fn().mockResolvedValue(undefined),
    createOAuthSignInUrl: vi.fn().mockResolvedValue("https://auth.example.com/oauth"),
    createOAuthLinkUrl: vi.fn().mockResolvedValue("https://auth.example.com/link"),
    completeOAuthCallback: vi.fn().mockResolvedValue({}),
    createTeam: vi.fn().mockResolvedValue({
      id: "team-created",
      name: "Created Team",
      slug: "created-team",
      role: "owner",
    }),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function loadController() {
  return import("../features/onboarding/onboarding-store");
}

describe("createOnboardingController", () => {
  it("bootstrap routes to needsAuth when there is no current session", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue(null),
    activateTeam: vi.fn().mockResolvedValue("actor-1"),
    });

    const controller = createOnboardingController(api);

    await controller.bootstrap();

    expect(api.getCurrentSession).toHaveBeenCalledTimes(1);
    expect(api.loadBootstrap).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "needsAuth",
    teamChoices: [],
      isBusy: false,
      errorMessage: null,
      pendingEmailOTPEmail: null,
    });
  });

  it("bootstrap stores team context and becomes ready when bootstrap data has a team", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
        teamChoices: [],
      } satisfies BootstrapResult),
    });

    const controller = createOnboardingController(api);

    await controller.bootstrap();

    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
    teamChoices: [],
      currentTeam: {
        id: "team-1",
        name: "Team Claw",
        slug: "team-claw",
        role: "owner",
      },
      currentMemberActorId: "member-1",
      isAnonymous: false,
    });
  });

  it("bootstrap rejects on failure and stores the safe failed state", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const controller = createOnboardingController(api);

    await expect(controller.bootstrap()).rejects.toThrow("boom");
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "failed",
    teamChoices: [],
      isBusy: false,
      errorMessage: "We couldn't load your account right now. Please try again.",
      currentTeam: null,
      currentMemberActorId: null,
    });
  });

  it("requestOtp stores the returned pending email", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      sendEmailOTP: vi.fn().mockResolvedValue({
        pendingEmail: "normalized@example.com",
      }),
    });
    const controller = createOnboardingController(api);

    await controller.requestOtp("person@example.com");

    expect(api.sendEmailOTP).toHaveBeenCalledWith("person@example.com");
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      pendingEmailOTPEmail: "normalized@example.com",
      isBusy: false,
      errorMessage: null,
    });
  });

  it("verifyOtp requires a pending email before verifying", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock();
    const controller = createOnboardingController(api);

    await expect(controller.verifyOtp("123456")).rejects.toThrow(
      "No pending email OTP request",
    );
    expect(api.verifyOTP).not.toHaveBeenCalled();
  });

  it("verifyOtp uses the stored email and then bootstraps", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: null,
        memberActorId: null,
        teamChoices: [],
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);

    await controller.requestOtp("person@example.com");
    await controller.verifyOtp("123456");

    expect(api.verifyOTP).toHaveBeenCalledWith("person@example.com", "123456");
    expect(api.loadBootstrap).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "createTeam",
    teamChoices: [],
      pendingEmailOTPEmail: null,
    });
  });

  it("signInWithPassword signs in and bootstraps without a pending-email step", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
    });
    const controller = createOnboardingController(api);

    // Unlike the OTP flow there is no requestOtp first: one call is the whole
    // sign-in, so it must reach bootstrap on its own.
    await controller.signInWithPassword("  Person@Example.com  ", "hunter2");

    expect(api.signInWithPassword).toHaveBeenCalledWith(
      "Person@Example.com",
      "hunter2",
    );
    expect(api.loadBootstrap).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "createTeam",
    teamChoices: [],
    });
  });

  it("signInWithPassword surfaces a rejected credential as an error, not a crash", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      signInWithPassword: vi
        .fn()
        .mockRejectedValue(new Error("Invalid login credentials")),
    });
    const controller = createOnboardingController(api);

    await expect(
      controller.signInWithPassword("person@example.com", "wrong"),
    ).rejects.toThrow("Invalid login credentials");

    expect(api.loadBootstrap).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      errorMessage: "Invalid login credentials",
      isBusy: false,
    });
  });

  it("signInWithOAuth opens the browser session, completes the callback, and bootstraps", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
        teamChoices: [],
      } satisfies BootstrapResult),
    });
    const openAuthSession = vi
      .fn()
      .mockResolvedValue({ type: "success", url: "teamclu://auth-callback?code=abc" });
    const controller = createOnboardingController(api);

    await controller.signInWithOAuth("google", {
      redirectTo: "teamclu://auth-callback",
      openAuthSession,
    });

    expect(api.createOAuthSignInUrl).toHaveBeenCalledWith(
      "google",
      "teamclu://auth-callback",
    );
    expect(openAuthSession).toHaveBeenCalledWith(
      "https://auth.example.com/oauth",
      "teamclu://auth-callback",
    );
    expect(api.completeOAuthCallback).toHaveBeenCalledWith(
      "teamclu://auth-callback?code=abc",
    );
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
    teamChoices: [],
      currentMemberActorId: "member-1",
      isBusy: false,
    });
  });

  it("signInWithOAuth clears busy state when the browser auth session is cancelled", async () => {
    const { createOnboardingController } = await loadController();
    const openAuthSession = vi.fn().mockResolvedValue({ type: "cancel" });
    const api = createApiMock();
    const controller = createOnboardingController(api);

    await controller.signInWithOAuth("apple", {
      redirectTo: "teamclu://auth-callback",
      openAuthSession,
    });

    expect(api.completeOAuthCallback).not.toHaveBeenCalled();
    expect(api.loadBootstrap).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      isBusy: false,
      errorMessage: null,
    });
  });

  /**
   * On Android the OAuth redirect is a deep link, so the OS hands the callback
   * URL to the app and the custom tab merely closes — `openAuthSessionAsync`
   * reports `dismiss`, exactly as if the user had backed out. Sign-in therefore
   * has to survive being carried entirely by the deep link.
   */
  it("signs in from the callback deep link even when the browser reports a dismiss", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: { id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" },
        memberActorId: "member-1",
        teamChoices: [],
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);

    await controller.signInWithOAuth("google", {
      redirectTo: "teamclu://auth-callback",
      openAuthSession: vi.fn().mockResolvedValue({ type: "dismiss" }),
    });
    expect(api.completeOAuthCallback).not.toHaveBeenCalled();

    await controller.completeOAuthFromUrl("teamclu://auth-callback?code=abc");

    expect(api.completeOAuthCallback).toHaveBeenCalledWith(
      "teamclu://auth-callback?code=abc",
    );
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
    teamChoices: [],
      currentMemberActorId: "member-1",
      isBusy: false,
    });
  });

  it("spends a callback url once even when both channels deliver it", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
    });
    const controller = createOnboardingController(api);
    const url = "teamclu://auth-callback?code=abc";

    // The browser result path wins the race...
    await controller.signInWithOAuth("google", {
      redirectTo: "teamclu://auth-callback",
      openAuthSession: vi.fn().mockResolvedValue({ type: "success", url }),
    });
    // ...then the OS delivers the same URL to the Linking listener.
    const second = await controller.completeOAuthFromUrl(url);

    expect(second).toBe(false);
    // A PKCE code is single-use: exchanging twice fails the second time.
    expect(api.completeOAuthCallback).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed callback exchange instead of returning silently", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      completeOAuthCallback: vi
        .fn()
        .mockRejectedValue(new Error("invalid or expired code")),
    });
    const controller = createOnboardingController(api);

    await expect(
      controller.completeOAuthFromUrl("teamclu://auth-callback?code=stale"),
    ).rejects.toThrow("invalid or expired code");

    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      isBusy: false,
      errorMessage: "invalid or expired code",
    });
  });

  it("linkIdentityWithOAuth links an identity, completes callback, and bootstraps", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
        teamChoices: [],
      } satisfies BootstrapResult),
    });
    const openAuthSession = vi
      .fn()
      .mockResolvedValue({ type: "success", url: "teamclu://auth-callback?code=abc" });
    const controller = createOnboardingController(api);

    await controller.linkIdentityWithOAuth("apple", {
      redirectTo: "teamclu://auth-callback",
      openAuthSession,
    });

    expect(api.createOAuthLinkUrl).toHaveBeenCalledWith(
      "apple",
      "teamclu://auth-callback",
    );
    expect(openAuthSession).toHaveBeenCalledWith(
      "https://auth.example.com/link",
      "teamclu://auth-callback",
    );
    expect(api.completeOAuthCallback).toHaveBeenCalledWith(
      "teamclu://auth-callback?code=abc",
    );
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
    teamChoices: [],
      isAnonymous: false,
      isBusy: false,
    });
  });

  it("signOut after ready returns to needsAuth and calls the API", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-1",
          name: "Team Claw",
          slug: "team-claw",
          role: "owner",
        },
        memberActorId: "member-1",
        teamChoices: [],
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);
    await controller.bootstrap();

    await controller.signOut();

    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "needsAuth",
    teamChoices: [],
      currentTeam: null,
      currentMemberActorId: null,
      isAnonymous: false,
    });
  });

  // The broker address is cached on the device so a cold or offline launch can
  // still connect, which means it outlives the account it was fetched for.
  // Without this, signing out of one deployment and into another on the same
  // device hands the new session the old broker whenever the config fetch fails.
  it("signOut drops the cached broker so the next account cannot inherit it", async () => {
    storageMock.items.set("teamclu.mqtt.broker-url", "mqtts://deployment-a.example.com:8883");

    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: { id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" },
        memberActorId: "member-1",
        teamChoices: [],
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);
    await controller.bootstrap();

    await controller.signOut();

    expect(storageMock.items.has("teamclu.mqtt.broker-url")).toBe(false);
  });

  it("ignores a stale signOut completion after a newer requestOtp", async () => {
    const { createOnboardingController } = await loadController();
    const deferredSignOut = createDeferredPromise<void>();
    const api = createApiMock({
      signOut: vi.fn().mockImplementation(() => deferredSignOut.promise),
      sendEmailOTP: vi.fn().mockResolvedValue({
        pendingEmail: "normalized@example.com",
      }),
    });
    const controller = createOnboardingController(api);

    const signOutPromise = controller.signOut();
    await Promise.resolve();
    await controller.requestOtp("person@example.com");
    deferredSignOut.resolve(undefined);
    await signOutPromise;

    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "loading",
    teamChoices: [],
      pendingEmailOTPEmail: "normalized@example.com",
      isBusy: false,
      errorMessage: null,
    });
  });

  it("ignores a stale bootstrap completion after signOut", async () => {
    const { createOnboardingController } = await loadController();
    const deferredBootstrap = createDeferredPromise<BootstrapResult>();
    const api = createApiMock({
      getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      loadBootstrap: vi.fn().mockImplementation(() => deferredBootstrap.promise),
    });
    const controller = createOnboardingController(api);

    const bootstrapPromise = controller.bootstrap();
    await Promise.resolve();
    await controller.signOut();
    deferredBootstrap.resolve({
      isAnonymous: false,
      team: {
        id: "team-stale",
        name: "Stale Team",
        slug: "stale-team",
        role: "owner",
      },
      memberActorId: "member-stale",
      teamChoices: [],
    });
    await bootstrapPromise;

    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "needsAuth",
    teamChoices: [],
      currentTeam: null,
      currentMemberActorId: null,
      pendingEmailOTPEmail: null,
      isBusy: false,
    });
  });

  it("createTeam calls the API and re-runs bootstrap into ready state", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockResolvedValue({
        isAnonymous: false,
        team: {
          id: "team-2",
          name: "Launch Team",
          slug: "launch-team",
          role: "owner",
        },
        memberActorId: "member-2",
        teamChoices: [],
      } satisfies BootstrapResult),
    });
    const controller = createOnboardingController(api);

    await controller.createTeam("Launch Team");

    expect(api.createTeam).toHaveBeenCalledWith("Launch Team");
    expect(api.loadBootstrap).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "ready",
    teamChoices: [],
      currentTeam: {
        id: "team-2",
        name: "Launch Team",
        slug: "launch-team",
        role: "owner",
      },
      currentMemberActorId: "member-2",
      isAnonymous: false,
    });
  });

  it("createTeam rejects on bootstrap failure and preserves the safe bootstrap failure state", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock({
      getCurrentSession: vi
        .fn()
        .mockResolvedValue({ user: { id: "user-1", is_anonymous: false } }),
      loadBootstrap: vi.fn().mockRejectedValue(new Error("raw bootstrap boom")),
    });
    const controller = createOnboardingController(api);

    await expect(controller.createTeam("Launch Team")).rejects.toThrow(
      "raw bootstrap boom",
    );

    expect(api.createTeam).toHaveBeenCalledWith("Launch Team");
    expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
      route: "failed",
    teamChoices: [],
      isBusy: false,
      errorMessage: "We couldn't load your account right now. Please try again.",
      currentTeam: null,
      currentMemberActorId: null,
    });
  });

  describe("switching team after login", () => {
    function memoryRememberedTeam(initial: string | null) {
      let value = initial;
      return {
        load: vi.fn(async () => value),
        save: vi.fn(async (teamId: string) => {
          value = teamId;
        }),
        clear: vi.fn(async () => {
          value = null;
        }),
      };
    }

    function bootstrapInto(teamId: string, actorId: string): BootstrapResult {
      return {
        isAnonymous: false,
        team: { id: teamId, name: teamId, slug: teamId, role: "member" },
        memberActorId: actorId,
        teamChoices: [],
      };
    }

    async function readyOn(
      teamId: string,
      overrides: Partial<OnboardingApi> = {},
    ) {
      const { createOnboardingController } = await loadController();
      const remembered = memoryRememberedTeam(teamId);
      const api = createApiMock({
        getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
        // Bootstrap adopts whichever team is remembered, as the real one does.
        loadBootstrap: vi.fn(async (rememberedTeamId?: string | null) =>
          bootstrapInto(rememberedTeamId ?? teamId, `actor-in-${rememberedTeamId ?? teamId}`),
        ),
        ...overrides,
      });
      const controller = createOnboardingController(api, remembered);
      await controller.bootstrap();
      return { api, controller, remembered };
    }

    it("switchTeam activates, remembers, and re-bootstraps into the new team", async () => {
      const { api, controller, remembered } = await readyOn("team-a");

      await controller.switchTeam("team-b");

      expect(api.activateTeam).toHaveBeenCalledWith("team-b");
      expect(remembered.save).toHaveBeenCalledWith("team-b");
      expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
        route: "ready",
        isBusy: false,
        currentTeam: { id: "team-b", name: "team-b", slug: "team-b", role: "member" },
        // The actor id is team-contextual and flips with the team.
        currentMemberActorId: "actor-in-team-b",
      });
    });

    it("a failed activation keeps the current team and rethrows", async () => {
      const { controller, remembered } = await readyOn("team-a", {
        activateTeam: vi.fn().mockRejectedValue(new Error("not a member")),
      });

      await expect(controller.switchTeam("team-b")).rejects.toThrow("not a member");

      // Unlike the login picker, there is a working team to stay in — the
      // route must not drop to selectTeam with no choices.
      expect(remembered.save).not.toHaveBeenCalled();
      expect(controller.getState()).toMatchObject<Partial<OnboardingState>>({
        route: "ready",
        isBusy: false,
        currentTeam: { id: "team-a", name: "team-a", slug: "team-a", role: "member" },
        currentMemberActorId: "actor-in-team-a",
      });
    });

    it("joinedTeam adopts the minted session before landing on the joined team", async () => {
      const calls: string[] = [];
      const { api, controller } = await readyOn("team-a", {
        adoptRefreshSession: vi.fn(async () => {
          calls.push("adopt");
        }),
      });
      (api.loadBootstrap as ReturnType<typeof vi.fn>).mockImplementation(
        async (rememberedTeamId?: string | null) => {
          calls.push(`bootstrap:${rememberedTeamId}`);
          return bootstrapInto(rememberedTeamId ?? "team-a", "joined-actor");
        },
      );

      await controller.joinedTeam("team-new", "refresh-1");

      expect(api.adoptRefreshSession).toHaveBeenCalledWith("refresh-1");
      expect(calls).toEqual(["adopt", "bootstrap:team-new"]);
      expect(controller.getState().currentTeam?.id).toBe("team-new");
    });

    it("joinedTeam without a minted session skips adoption", async () => {
      const { api, controller } = await readyOn("team-a");

      await controller.joinedTeam("team-new", null);

      expect(api.adoptRefreshSession).not.toHaveBeenCalled();
      expect(controller.getState().currentTeam?.id).toBe("team-new");
    });
  });

  it("notifies subscribers when state changes", async () => {
    const { createOnboardingController } = await loadController();
    const api = createApiMock();
    const controller = createOnboardingController(api);
    const listener = vi.fn();

    const unsubscribe = controller.subscribe(listener);
    await controller.requestOtp("person@example.com");
    unsubscribe();
    await controller.requestOtp("other@example.com");

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
