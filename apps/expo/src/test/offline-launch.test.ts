import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import { CloudApiError } from "../lib/cloud-api/client";
import {
  createLastAppContextStore,
  isNetworkUnreachableError,
  parseLastAppContext,
  type LastAppContext,
} from "../features/onboarding/offline-launch";
import { createOnboardingController } from "../features/onboarding/onboarding-store";
import { createRememberedTeamStore } from "../features/onboarding/remembered-team";
import { createOnboardingIntentStore } from "../features/onboarding/onboarding-intent";
import type { BootstrapResult } from "../features/onboarding/onboarding-types";

type OnboardingApi = Parameters<typeof createOnboardingController>[0];

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => void items.set(key, value),
    removeItem: async (key: string) => void items.delete(key),
  };
}

const TEAM = { id: "team-1", name: "Team Claw", slug: "team-claw", role: "owner" };
const CACHED: LastAppContext = { team: TEAM, memberActorId: "member-1", isAnonymous: false };
const offline = () => new TypeError("Network request failed");

function apiMock(overrides: Partial<OnboardingApi> = {}): OnboardingApi {
  return {
    getCurrentSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
    loadBootstrap: vi.fn().mockResolvedValue({
      isAnonymous: false,
      team: TEAM,
      memberActorId: "member-1",
      teamChoices: [],
    } satisfies BootstrapResult),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OnboardingApi;
}

function setup(api: OnboardingApi) {
  const storage = memoryStorage();
  const lastContext = createLastAppContextStore(storage);
  const controller = createOnboardingController(
    api,
    createRememberedTeamStore(storage),
    createOnboardingIntentStore(storage as never),
    lastContext,
  );
  return { controller, lastContext, storage };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("isNetworkUnreachableError", () => {
  it("recognises transport failures", () => {
    expect(isNetworkUnreachableError(new TypeError("Network request failed"))).toBe(true);
    expect(isNetworkUnreachableError(new TypeError("Network request timed out"))).toBe(true);
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    expect(isNetworkUnreachableError(abort)).toBe(true);
  });

  it("does not treat a server answer or an app bug as offline", () => {
    expect(isNetworkUnreachableError(new CloudApiError(503, "Unavailable"))).toBe(false);
    expect(isNetworkUnreachableError(new CloudApiError(401, "Unauthorized"))).toBe(false);
    expect(isNetworkUnreachableError(new TypeError("x is not a function"))).toBe(false);
    expect(isNetworkUnreachableError(new SyntaxError("Unexpected token <"))).toBe(false);
    expect(isNetworkUnreachableError("Network request failed")).toBe(false);
    expect(isNetworkUnreachableError(null)).toBe(false);
  });
});

describe("last app context store", () => {
  it("round-trips and clears", async () => {
    const store = createLastAppContextStore(memoryStorage());
    expect(await store.load()).toBeNull();
    await store.save(CACHED);
    expect(await store.load()).toEqual(CACHED);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("rejects a malformed entry rather than opening a half team", () => {
    expect(parseLastAppContext(null)).toBeNull();
    expect(parseLastAppContext({ team: { id: "" }, memberActorId: "m" })).toBeNull();
    expect(parseLastAppContext({ team: { id: "t" }, memberActorId: "" })).toBeNull();
    expect(parseLastAppContext({ team: { id: "t" }, memberActorId: "m" })).toEqual({
      team: { id: "t", name: "", slug: "", role: "member" },
      memberActorId: "m",
      isAnonymous: false,
    });
  });
});

describe("offline launch", () => {
  it("remembers the team on every successful entry", async () => {
    const { controller, lastContext } = setup(apiMock());
    await controller.bootstrap();
    await flush();
    expect(await lastContext.load()).toEqual(CACHED);
  });

  it("enters the cached team when the server can't be reached", async () => {
    const { controller, lastContext } = setup(
      apiMock({ loadBootstrap: vi.fn().mockRejectedValue(offline()) }),
    );
    await lastContext.save(CACHED);

    await controller.bootstrap();

    expect(controller.getState()).toMatchObject({
      route: "ready",
      currentTeam: TEAM,
      currentMemberActorId: "member-1",
      isBusy: false,
    });
    expect(controller.isOfflineLaunch()).toBe(true);
  });

  it("also covers a token refresh that couldn't reach the server", async () => {
    const { controller, lastContext } = setup(
      apiMock({ getCurrentSession: vi.fn().mockRejectedValue(offline()) }),
    );
    await lastContext.save(CACHED);
    await controller.bootstrap();
    expect(controller.getState().route).toBe("ready");
  });

  it("still fails without a cached team", async () => {
    const { controller } = setup(apiMock({ loadBootstrap: vi.fn().mockRejectedValue(offline()) }));
    await expect(controller.bootstrap()).rejects.toThrow();
    expect(controller.getState().route).toBe("failed");
    expect(controller.isOfflineLaunch()).toBe(false);
  });

  it("still fails when the server answered with an error", async () => {
    const { controller, lastContext } = setup(
      apiMock({ loadBootstrap: vi.fn().mockRejectedValue(new CloudApiError(500, "boom")) }),
    );
    await lastContext.save(CACHED);
    await expect(controller.bootstrap()).rejects.toThrow();
    expect(controller.getState().route).toBe("failed");
  });

  it("signing out forgets the cached team", async () => {
    const { controller, lastContext } = setup(apiMock());
    await controller.bootstrap();
    await flush();
    await controller.signOut();
    await flush();
    expect(await lastContext.load()).toBeNull();
  });

  it("revalidation keeps the team quietly when it is still a membership", async () => {
    const loadBootstrap = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValue({
      isAnonymous: false,
      team: TEAM,
      memberActorId: "member-1",
      teamChoices: [],
    } satisfies BootstrapResult);
    const { controller, lastContext } = setup(apiMock({ loadBootstrap }));
    await lastContext.save(CACHED);
    await controller.bootstrap();
    const before = controller.getState();

    await controller.revalidateAfterOfflineLaunch();

    expect(controller.isOfflineLaunch()).toBe(false);
    expect(controller.getState()).toBe(before);
    expect(loadBootstrap).toHaveBeenLastCalledWith("team-1");
  });

  it("revalidation lands elsewhere when the team is gone", async () => {
    const loadBootstrap = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValue({
      isAnonymous: false,
      team: null,
      memberActorId: null,
      teamChoices: [],
    } satisfies BootstrapResult);
    const { controller, lastContext } = setup(apiMock({ loadBootstrap }));
    await lastContext.save(CACHED);
    await controller.bootstrap();

    await controller.revalidateAfterOfflineLaunch();

    expect(controller.getState().route).not.toBe("ready");
    expect(controller.getState().currentTeam).toBeNull();
  });

  it("revalidation stays flagged while still offline", async () => {
    const { controller, lastContext } = setup(
      apiMock({ loadBootstrap: vi.fn().mockRejectedValue(offline()) }),
    );
    await lastContext.save(CACHED);
    await controller.bootstrap();

    await controller.revalidateAfterOfflineLaunch();

    expect(controller.isOfflineLaunch()).toBe(true);
    expect(controller.getState().route).toBe("ready");
  });
});
