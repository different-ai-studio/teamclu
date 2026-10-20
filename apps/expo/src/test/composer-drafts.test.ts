import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => memory.get(key) ?? null,
    setItem: async (key: string, value: string) => void memory.set(key, value),
    removeItem: async (key: string) => void memory.delete(key),
    getAllKeys: async () => [...memory.keys()],
    multiGet: async (keys: string[]) => keys.map((k) => [k, memory.get(k) ?? null]),
    multiRemove: async (keys: string[]) => keys.forEach((k) => memory.delete(k)),
  },
}));

describe("composer drafts", () => {
  beforeEach(() => {
    memory.clear();
    vi.resetModules();
  });

  it("hydrates drafts saved by an earlier launch so the list can preview them", async () => {
    memory.set("teamclu.composerDraft.v1:s1", "half a thought");
    memory.set("unrelated", "x");
    const drafts = await import("../features/sessions/composer-drafts");
    await drafts.hydrateComposerDrafts();
    expect([...drafts.getComposerDraftsSnapshot()]).toEqual([["s1", "half a thought"]]);
  });

  it("notifies on save, drops whitespace-only drafts, and clears on sign-out", async () => {
    const drafts = await import("../features/sessions/composer-drafts");
    const listener = vi.fn();
    drafts.subscribeComposerDrafts(listener);

    await drafts.saveComposerDraft("s1", "hello");
    expect(drafts.getComposerDraftsSnapshot().get("s1")).toBe("hello");
    expect(memory.get("teamclu.composerDraft.v1:s1")).toBe("hello");

    await drafts.saveComposerDraft("s1", "   ");
    expect(drafts.getComposerDraftsSnapshot().has("s1")).toBe(false);
    expect(memory.has("teamclu.composerDraft.v1:s1")).toBe(false);

    await drafts.saveComposerDraft("s2", "keep");
    await drafts.clearComposerDrafts();
    expect(drafts.getComposerDraftsSnapshot().size).toBe(0);
    expect(memory.size).toBe(0);
    expect(listener).toHaveBeenCalled();
  });
});
