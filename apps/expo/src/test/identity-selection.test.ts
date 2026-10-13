import { describe, expect, it, vi } from "vitest";

import {
  initialOnboardingState,
  onboardingReducer,
} from "../features/onboarding/onboarding-reducer";
import type {
  BootstrapResult,
  MyIdentity,
  OnboardingState,
} from "../features/onboarding/onboarding-types";

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

const own: MyIdentity = {
  userId: "u-own",
  orgId: "o1",
  orgName: "Own",
  orgLogo: null,
  adminType: 3,
  isCurrent: true,
};
const co: MyIdentity = {
  userId: "u-co",
  orgId: "o2",
  orgName: "Co",
  orgLogo: null,
  adminType: 2,
  isCurrent: false,
};

const readyBootstrap: BootstrapResult = {
  isAnonymous: false,
  team: { id: "team-1", name: "Alpha", slug: "alpha", role: "owner" },
  memberActorId: "m1",
  teamChoices: [],
};

function memoryRememberedTeam(initial: string | null = null) {
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

function memoryIntent() {
  return {
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

function createApiMock(overrides: Partial<OnboardingApi> = {}): OnboardingApi {
  return {
    getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "u-own" } }),
    loadBootstrap: vi.fn().mockResolvedValue(readyBootstrap),
    signInWithPassword: vi.fn().mockResolvedValue(undefined),
    sendEmailOTP: vi.fn(async (email: string) => ({ pendingEmail: email })),
    verifyOTP: vi.fn().mockResolvedValue(undefined),
    completeOAuthCallback: vi.fn().mockResolvedValue({}),
    listMyIdentities: vi.fn().mockResolvedValue([]),
    switchIdentity: vi.fn().mockResolvedValue(undefined),
    joinByLink: vi.fn().mockResolvedValue({ teamId: "t-joined", alreadyMember: false }),
    ...overrides,
  } as unknown as OnboardingApi;
}

async function makeController(api: OnboardingApi, remembered = memoryRememberedTeam()) {
  const { createOnboardingController } = await import(
    "../features/onboarding/onboarding-store"
  );
  return createOnboardingController(api, remembered, memoryIntent() as never);
}

describe("onboardingReducer — identity picker", () => {
  it("identitiesOffered routes to the org picker and clears the login steps", () => {
    const state = onboardingReducer(
      { ...initialOnboardingState, isBusy: true, pendingEmailOTPEmail: "a@b.test" },
      { type: "identitiesOffered", identities: [own, co] },
    );
    expect(state).toMatchObject<Partial<OnboardingState>>({
      route: "selectIdentity",
      identityChoices: [own, co],
      isBusy: false,
      pendingEmailOTPEmail: null,
    });
  });

  it("a failed choice stays on the picker with the error", () => {
    const offered = onboardingReducer(initialOnboardingState, {
      type: "identitiesOffered",
      identities: [own, co],
    });
    const failed = onboardingReducer(
      { ...offered, isBusy: true },
      { type: "identitySelectionFailed", message: "forbidden" },
    );
    expect(failed).toMatchObject({
      route: "selectIdentity",
      identityChoices: [own, co],
      isBusy: false,
      errorMessage: "forbidden",
    });
  });

  it("a finished bootstrap and sign-out drop the choices", () => {
    const offered = onboardingReducer(initialOnboardingState, {
      type: "identitiesOffered",
      identities: [own, co],
    });
    expect(
      onboardingReducer(offered, { type: "bootstrapResolved", payload: readyBootstrap })
        .identityChoices,
    ).toEqual([]);
    expect(onboardingReducer(offered, { type: "signedOut" }).identityChoices).toEqual([]);
  });
});

describe("onboarding controller — identity picker (iOS #1659)", () => {
  it("a sign-in that names several identities stops at the org picker", async () => {
    const api = createApiMock({ listMyIdentities: vi.fn().mockResolvedValue([own, co]) });
    const controller = await makeController(api);

    await controller.signInWithPassword("a@b.test", "pw");

    expect(controller.getState()).toMatchObject({
      route: "selectIdentity",
      identityChoices: [own, co],
      isBusy: false,
    });
    expect(api.loadBootstrap).not.toHaveBeenCalled();

    await controller.chooseIdentity(co);

    expect(api.switchIdentity).toHaveBeenCalledWith("u-co");
    expect(controller.getState()).toMatchObject({ route: "ready", identityChoices: [] });
  });

  it("the email code path offers the picker too", async () => {
    const api = createApiMock({ listMyIdentities: vi.fn().mockResolvedValue([own, co]) });
    const controller = await makeController(api);

    await controller.requestOtp("a@b.test");
    await controller.verifyOtp("123456");

    expect(controller.getState().route).toBe("selectIdentity");
  });

  it("picking the current identity bootstraps without switching", async () => {
    const api = createApiMock();
    const controller = await makeController(api);

    await controller.chooseIdentity(own);

    expect(api.switchIdentity).not.toHaveBeenCalled();
    expect(controller.getState().route).toBe("ready");
  });

  it("switching identity forgets the previous account's remembered team", async () => {
    const remembered = memoryRememberedTeam("team-of-other-identity");
    const api = createApiMock();
    const controller = await makeController(api, remembered);

    await controller.chooseIdentity(co);

    expect(remembered.clear).toHaveBeenCalled();
    expect(api.loadBootstrap).toHaveBeenCalledWith(null);
  });

  it("a single identity that is not the signed-in account is entered directly", async () => {
    const api = createApiMock({ listMyIdentities: vi.fn().mockResolvedValue([co]) });
    const controller = await makeController(api);

    await controller.signInWithPassword("a@b.test", "pw");

    expect(api.switchIdentity).toHaveBeenCalledWith("u-co");
    expect(controller.getState().route).toBe("ready");
  });

  it("a failed identity lookup keeps the signed-in account", async () => {
    const api = createApiMock({
      listMyIdentities: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const controller = await makeController(api);

    await controller.signInWithPassword("a@b.test", "pw");

    expect(api.switchIdentity).not.toHaveBeenCalled();
    expect(controller.getState().route).toBe("ready");
  });

  it("a failed switch stays on the picker with the error", async () => {
    const api = createApiMock({
      listMyIdentities: vi.fn().mockResolvedValue([own, co]),
      switchIdentity: vi.fn().mockRejectedValue(new Error("not yours")),
    });
    const controller = await makeController(api);
    await controller.signInWithPassword("a@b.test", "pw");

    await controller.chooseIdentity(co);

    expect(controller.getState()).toMatchObject({
      route: "selectIdentity",
      errorMessage: "not yours",
      isBusy: false,
    });
    expect(api.loadBootstrap).not.toHaveBeenCalled();
  });
});

describe("onboarding controller — join link (#1672)", () => {
  it("redeems, remembers the joined team, and lands on it", async () => {
    const remembered = memoryRememberedTeam();
    const api = createApiMock();
    const controller = await makeController(api, remembered);

    await controller.joinByLink("tok", "https://api.other.test");

    expect(api.joinByLink).toHaveBeenCalledWith("tok", "https://api.other.test");
    expect(remembered.save).toHaveBeenCalledWith("t-joined");
    expect(api.loadBootstrap).toHaveBeenCalledWith("t-joined");
    expect(controller.getState().route).toBe("ready");
  });

  it("rethrows a dead link and leaves the error for the sheet", async () => {
    const api = createApiMock({
      joinByLink: vi.fn().mockRejectedValue(new Error("This join link has expired.")),
    });
    const controller = await makeController(api);

    await expect(controller.joinByLink("tok", null)).rejects.toThrow(/expired/);
    expect(controller.getState()).toMatchObject({
      isBusy: false,
      errorMessage: "This join link has expired.",
    });
    expect(api.loadBootstrap).not.toHaveBeenCalled();
  });
});

describe("onboarding api — identities and join links", () => {
  function makeClient(overrides: { get?: unknown; post?: unknown; setRefreshSession?: unknown }) {
    return {
      auth: {
        getSession: vi
          .fn()
          .mockResolvedValue({ data: { session: { access_token: "at", user: { id: "u" } } } }),
        setRefreshSession:
          overrides.setRefreshSession ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
      api: { get: overrides.get ?? vi.fn(), post: overrides.post ?? vi.fn() },
    } as never;
  }

  it("lists identities and drops rows without a user id", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const get = vi.fn().mockResolvedValue({
      items: [
        { userId: "u-own", orgId: "o1", orgName: "Own", adminType: 3, isCurrent: true },
        { userId: null, orgId: "o9" },
        { userId: "u-co", orgId: null, orgName: " ", adminType: 2, isCurrent: false },
      ],
    });
    const api = createOnboardingApi(makeClient({ get }));

    await expect(api.listMyIdentities()).resolves.toEqual([
      own,
      { userId: "u-co", orgId: null, orgName: null, orgLogo: null, adminType: 2, isCurrent: false },
    ]);
    expect(get).toHaveBeenCalledWith("/v1/auth/identities");
  });

  it("switches identity by installing the minted session", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const post = vi.fn().mockResolvedValue({ refreshToken: "rt-co" });
    const setRefreshSession = vi.fn().mockResolvedValue({ data: {}, error: null });
    const api = createOnboardingApi(makeClient({ post, setRefreshSession }));

    await api.switchIdentity("u-co");

    expect(post).toHaveBeenCalledWith("/v1/auth/identities/u-co/session", {});
    expect(setRefreshSession).toHaveBeenCalledWith("rt-co");
  });

  it("redeems a same-server join link through the app client", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const post = vi.fn().mockResolvedValue({ teamId: "t-1", alreadyMember: true });
    const api = createOnboardingApi(makeClient({ post }));

    await expect(api.joinByLink("t/k", null)).resolves.toEqual({
      teamId: "t-1",
      alreadyMember: true,
    });
    expect(post).toHaveBeenCalledWith("/v1/join-links/t%2Fk/join");
  });

  it("redeems another server's link there, with this session's bearer", async () => {
    const { createOnboardingApi } = await import("../lib/supabase/onboarding-api");
    const post = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ teamId: "t-2", alreadyMember: false }),
    });
    const api = createOnboardingApi(makeClient({ post }), { fetchImpl: fetchImpl as never });

    await expect(api.joinByLink("tok", "https://api.other.test")).resolves.toMatchObject({
      teamId: "t-2",
    });
    expect(post).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.other.test/v1/join-links/tok/join");
    expect(init.headers.Authorization).toBe("Bearer at");
  });
});
