import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

import {
  createIntroFlagStore,
  createOnboardingIntentStore,
  parseOnboardingIntent,
  resolveSignedOutEntry,
} from "../features/onboarding/onboarding-intent";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn(async (key: string) => items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void items.set(key, value)),
    removeItem: vi.fn(async (key: string) => void items.delete(key)),
  };
}

describe("parseOnboardingIntent", () => {
  it("accepts join and create, trimming whitespace", () => {
    expect(parseOnboardingIntent("join")).toBe("join");
    expect(parseOnboardingIntent(" create ")).toBe("create");
  });

  it("reads anything else as no recorded intent", () => {
    for (const raw of [null, undefined, "", "JOIN", "signup", 1, {}]) {
      expect(parseOnboardingIntent(raw)).toBeNull();
    }
  });
});

describe("createOnboardingIntentStore", () => {
  it("round-trips an intent under the iOS key and clears it", async () => {
    const storage = memoryStorage();
    const store = createOnboardingIntentStore(storage as never);
    expect(await store.load()).toBeNull();
    await store.save("join");
    expect(storage.items.get("teamclu.onboardingIntent")).toBe("join");
    expect(await store.load()).toBe("join");
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("ignores a corrupt stored value", async () => {
    const storage = memoryStorage({ "teamclu.onboardingIntent": "maybe" });
    expect(await createOnboardingIntentStore(storage as never).load()).toBeNull();
  });

  it("swallows storage failures", async () => {
    const broken = {
      getItem: vi.fn().mockRejectedValue(new Error("boom")),
      setItem: vi.fn().mockRejectedValue(new Error("boom")),
      removeItem: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const store = createOnboardingIntentStore(broken as never);
    await expect(store.load()).resolves.toBeNull();
    await expect(store.save("create")).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

describe("createIntroFlagStore", () => {
  it("is unseen on a fresh install and seen once marked", async () => {
    const storage = memoryStorage();
    const flag = createIntroFlagStore(storage as never);
    expect(await flag.hasSeen()).toBe(false);
    await flag.markSeen();
    expect(await flag.hasSeen()).toBe(true);
  });

  it("skips the intro when storage cannot be read", async () => {
    const broken = { getItem: vi.fn().mockRejectedValue(new Error("x")) };
    expect(await createIntroFlagStore(broken as never).hasSeen()).toBe(true);
  });
});

describe("resolveSignedOutEntry", () => {
  it("shows the intro only on first install", () => {
    expect(resolveSignedOutEntry({ hasSeenIntro: false, hasPendingInvite: false })).toBe("intro");
    expect(resolveSignedOutEntry({ hasSeenIntro: true, hasPendingInvite: false })).toBe("choice");
  });

  it("sends an invite-link holder straight to sign-in, intro or not", () => {
    expect(resolveSignedOutEntry({ hasSeenIntro: false, hasPendingInvite: true })).toBe(
      "invitedLogin",
    );
    expect(resolveSignedOutEntry({ hasSeenIntro: true, hasPendingInvite: true })).toBe(
      "invitedLogin",
    );
  });
});
