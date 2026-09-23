import { describe, expect, it, vi } from "vitest";

import type { BootstrapResult } from "../features/onboarding/onboarding-types";
import type { OnboardingIntent, OnboardingIntentStore } from "../features/onboarding/onboarding-intent";
import type { RememberedTeamStore } from "../features/onboarding/remembered-team";

vi.mock("@react-native-async-storage/async-storage", () => {
  const items = new Map<string, string>();
  return {
    default: {
      getItem: async (key: string) => items.get(key) ?? null,
      setItem: async (key: string, value: string) => void items.set(key, value),
      removeItem: async (key: string) => void items.delete(key),
    },
  };
});

type OnboardingApi = ReturnType<
  (typeof import("../lib/supabase/onboarding-api"))["createOnboardingApi"]
>;

const NO_TEAM: BootstrapResult = {
  isAnonymous: false,
  team: null,
  memberActorId: null,
  teamChoices: [],
};

const WITH_TEAM: BootstrapResult = {
  isAnonymous: false,
  team: { id: "team-1", name: "Ops", slug: "ops", role: "member" },
  memberActorId: "actor-1",
  teamChoices: [],
};

function createApi(overrides: Partial<OnboardingApi> = {}): OnboardingApi {
  return {
    getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
    activateTeam: vi.fn().mockResolvedValue("actor-1"),
    loadBootstrap: vi.fn().mockResolvedValue(NO_TEAM),
    sendEmailOTP: vi.fn(),
    verifyOTP: vi.fn(),
    signInWithPassword: vi.fn(),
    createOAuthSignInUrl: vi.fn(),
    createOAuthLinkUrl: vi.fn(),
    completeOAuthCallback: vi.fn(),
    createTeam: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
    sendPhoneOTP: vi.fn().mockImplementation(async (phone: string) => ({ pendingPhone: phone })),
    verifyPhoneOTP: vi.fn().mockResolvedValue({ type: "session", session: {} }),
    loginWithPhoneAccount: vi.fn().mockResolvedValue(undefined),
    hasAnyTeam: vi.fn().mockResolvedValue(false),
    listPendingInvites: vi.fn().mockResolvedValue([]),
    acceptPendingInvite: vi.fn().mockResolvedValue("team-1"),
    declinePendingInvite: vi.fn().mockResolvedValue(undefined),
    claimInvite: vi.fn().mockResolvedValue("team-1"),
    ...overrides,
  } as OnboardingApi;
}

function memoryIntent(initial: OnboardingIntent | null = null) {
  let value = initial;
  const store: OnboardingIntentStore & { peek: () => OnboardingIntent | null } = {
    load: vi.fn(async () => value),
    save: vi.fn(async (next: OnboardingIntent) => {
      value = next;
    }),
    clear: vi.fn(async () => {
      value = null;
    }),
    peek: () => value,
  };
  return store;
}

function memoryRemembered() {
  let value: string | null = null;
  const store: RememberedTeamStore & { peek: () => string | null } = {
    load: vi.fn(async () => value),
    save: vi.fn(async (next: string) => {
      value = next;
    }),
    clear: vi.fn(async () => {
      value = null;
    }),
    peek: () => value,
  };
  return store;
}

async function makeController(
  api: OnboardingApi,
  intent = memoryIntent(),
  remembered = memoryRemembered(),
) {
  const { createOnboardingController } = await import(
    "../features/onboarding/onboarding-store"
  );
  return { controller: createOnboardingController(api, remembered, intent), intent, remembered };
}

describe("onboarding intent after sign-in", () => {
  it("lands a joiner with no team on noTeam and creates nothing", async () => {
    const api = createApi();
    const { controller } = await makeController(api, memoryIntent("join"));
    await controller.bootstrap();
    expect(controller.getState().route).toBe("noTeam");
    expect(api.createTeam).not.toHaveBeenCalled();
  });

  it("keeps the create path for create and for no recorded intent", async () => {
    for (const recorded of ["create", null] as const) {
      const { controller } = await makeController(createApi(), memoryIntent(recorded));
      await controller.bootstrap();
      expect(controller.getState().route).toBe("createTeam");
    }
  });

  it("clears the intent once the user is in a team", async () => {
    const api = createApi({ loadBootstrap: vi.fn().mockResolvedValue(WITH_TEAM) });
    const intent = memoryIntent("join");
    const { controller } = await makeController(api, intent);
    await controller.bootstrap();
    expect(controller.getState().route).toBe("ready");
    expect(intent.peek()).toBeNull();
  });

  it("keeps the intent across a relaunch while there is still no team", async () => {
    const intent = memoryIntent("join");
    const { controller } = await makeController(createApi(), intent);
    await controller.bootstrap();
    await controller.bootstrap();
    expect(intent.peek()).toBe("join");
    expect(controller.getState().route).toBe("noTeam");
  });

  it("setIntent records the choice made before sign-in", async () => {
    const intent = memoryIntent();
    const { controller } = await makeController(createApi(), intent);
    await controller.setIntent("create");
    expect(intent.peek()).toBe("create");
  });

  it("createTeamFromNoTeam switches to create and re-routes", async () => {
    const intent = memoryIntent("join");
    const { controller } = await makeController(createApi(), intent);
    await controller.bootstrap();
    await controller.createTeamFromNoTeam();
    expect(intent.peek()).toBe("create");
    expect(controller.getState().route).toBe("createTeam");
  });
});

describe("no-team screen actions", () => {
  it("joinWithInvite claims as the signed-in user, remembers the team, lands on it", async () => {
    const loadBootstrap = vi
      .fn()
      .mockResolvedValueOnce(NO_TEAM)
      .mockResolvedValueOnce(WITH_TEAM);
    const api = createApi({ loadBootstrap });
    const { controller, remembered } = await makeController(api, memoryIntent("join"));
    await controller.bootstrap();
    await controller.joinWithInvite("tok");
    expect(api.claimInvite).toHaveBeenCalledWith("tok");
    expect(api.signOut).not.toHaveBeenCalled();
    expect(remembered.peek()).toBe("team-1");
    expect(controller.getState().route).toBe("ready");
  });

  it("a failed claim stays on noTeam with the error", async () => {
    const api = createApi({ claimInvite: vi.fn().mockRejectedValue(new Error("Invite expired")) });
    const { controller } = await makeController(api, memoryIntent("join"));
    await controller.bootstrap();
    await expect(controller.joinWithInvite("tok")).rejects.toThrow("Invite expired");
    expect(controller.getState()).toMatchObject({
      route: "noTeam",
      errorMessage: "Invite expired",
      isBusy: false,
    });
  });

  it("accepting a pending invite drops it from the list and lands on its team", async () => {
    const invite = {
      id: "inv-1",
      teamId: "team-1",
      teamName: "Ops",
      teamRole: null,
      invitedByDisplayName: null,
    };
    const loadBootstrap = vi.fn().mockResolvedValueOnce(NO_TEAM).mockResolvedValueOnce(WITH_TEAM);
    const api = createApi({
      loadBootstrap,
      listPendingInvites: vi.fn().mockResolvedValue([invite]),
    });
    const { controller, remembered } = await makeController(api, memoryIntent("join"));
    await controller.bootstrap();
    await controller.refreshPendingInvites();
    expect(controller.getState().pendingInvites).toEqual([invite]);
    await controller.acceptPendingInvite("inv-1");
    expect(api.acceptPendingInvite).toHaveBeenCalledWith("inv-1");
    expect(remembered.peek()).toBe("team-1");
    expect(controller.getState().pendingInvites).toEqual([]);
    expect(controller.getState().route).toBe("ready");
  });

  it("an unreachable invite list reads as no invites", async () => {
    const api = createApi({ listPendingInvites: vi.fn().mockRejectedValue(new Error("down")) });
    const { controller } = await makeController(api);
    await controller.refreshPendingInvites();
    expect(controller.getState().pendingInvites).toEqual([]);
  });

  it("refreshNoTeam only re-bootstraps once a team has appeared", async () => {
    const hasAnyTeam = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const loadBootstrap = vi
      .fn()
      .mockResolvedValueOnce(NO_TEAM)
      .mockResolvedValueOnce(WITH_TEAM);
    const api = createApi({ hasAnyTeam, loadBootstrap });
    const { controller } = await makeController(api, memoryIntent("join"));
    await controller.bootstrap();
    await controller.refreshNoTeam();
    expect(loadBootstrap).toHaveBeenCalledTimes(1);
    expect(controller.getState().route).toBe("noTeam");
    await controller.refreshNoTeam();
    expect(loadBootstrap).toHaveBeenCalledTimes(2);
    expect(controller.getState().route).toBe("ready");
  });
});

describe("phone sign-in", () => {
  it("sends a code and moves to the code step", async () => {
    const api = createApi({ getCurrentSession: vi.fn().mockResolvedValue(null) });
    const { controller } = await makeController(api);
    await controller.bootstrap();
    await controller.requestPhoneOtp("+8613800138000");
    expect(api.sendPhoneOTP).toHaveBeenCalledWith("+8613800138000");
    expect(controller.getState()).toMatchObject({
      pendingPhoneOTPPhone: "+8613800138000",
      pendingEmailOTPEmail: null,
      isBusy: false,
    });
  });

  it("a single-account code signs in and bootstraps", async () => {
    const api = createApi({ loadBootstrap: vi.fn().mockResolvedValue(WITH_TEAM) });
    const { controller } = await makeController(api);
    await controller.requestPhoneOtp("+8613800138000");
    await controller.verifyPhoneOtp("123456");
    expect(api.verifyPhoneOTP).toHaveBeenCalledWith("+8613800138000", "123456");
    expect(controller.getState()).toMatchObject({
      route: "ready",
      pendingPhoneOTPPhone: null,
      phoneAccounts: [],
    });
  });

  it("several accounts open the picker; choosing one re-posts the same code with its id", async () => {
    const accounts = [
      {
        id: "u1",
        orgId: "o1",
        orgName: "Betly",
        orgLogo: null,
        adminType: 2,
        nickname: "Ann",
        email: "",
      },
      {
        id: "u2",
        orgId: "o2",
        orgName: "香蕉攀岩",
        orgLogo: null,
        adminType: 2,
        nickname: "Ann",
        email: "",
      },
    ];
    const api = createApi({
      verifyPhoneOTP: vi.fn().mockResolvedValue({ type: "multiUser", accounts }),
      loadBootstrap: vi.fn().mockResolvedValue(WITH_TEAM),
    });
    const { controller } = await makeController(api);
    await controller.requestPhoneOtp("+8613800138000");
    await controller.verifyPhoneOtp("654321");
    expect(controller.getState()).toMatchObject({ phoneAccounts: accounts, isBusy: false });
    expect(api.loadBootstrap).not.toHaveBeenCalled();

    await controller.selectPhoneAccount("u2");
    expect(api.loginWithPhoneAccount).toHaveBeenCalledWith("+8613800138000", "654321", "u2");
    expect(controller.getState()).toMatchObject({ route: "ready", phoneAccounts: [] });
  });

  it("dismissing the picker keeps the code step so another account can be tried", async () => {
    const api = createApi({
      verifyPhoneOTP: vi.fn().mockResolvedValue({
        type: "multiUser",
        accounts: [
          { id: "u1", orgId: null, orgName: null, orgLogo: null, adminType: 0, nickname: "", email: "" },
        ],
      }),
    });
    const { controller } = await makeController(api);
    await controller.requestPhoneOtp("+8613800138000");
    await controller.verifyPhoneOtp("111111");
    controller.dismissPhoneAccounts();
    expect(controller.getState()).toMatchObject({
      phoneAccounts: [],
      pendingPhoneOTPPhone: "+8613800138000",
    });
  });

  it("a wrong code surfaces the error and stays on the code step", async () => {
    const api = createApi({
      verifyPhoneOTP: vi.fn().mockRejectedValue(new Error("Invalid code")),
    });
    const { controller } = await makeController(api);
    await controller.requestPhoneOtp("+8613800138000");
    await expect(controller.verifyPhoneOtp("000000")).rejects.toThrow("Invalid code");
    expect(controller.getState()).toMatchObject({
      errorMessage: "Invalid code",
      pendingPhoneOTPPhone: "+8613800138000",
      isBusy: false,
    });
  });

  it("resetPendingPhone goes back to number entry", async () => {
    const { controller } = await makeController(createApi());
    await controller.requestPhoneOtp("+8613800138000");
    controller.resetPendingPhone();
    expect(controller.getState().pendingPhoneOTPPhone).toBeNull();
    await expect(controller.selectPhoneAccount("u1")).rejects.toThrow();
  });
});
