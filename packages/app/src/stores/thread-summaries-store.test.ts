import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listThreadSummaries: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ sessions: { listThreadSummaries: mocks.listThreadSummaries } }),
}));

vi.mock("@/lib/session/thread-fork-metadata", () => ({
  rememberThreadForkMetadata: vi.fn(),
}));

describe("thread-summaries-store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("caches a loaded list and does not ask twice", async () => {
    mocks.listThreadSummaries.mockResolvedValue([]);
    const { useThreadSummariesStore } = await import("./thread-summaries-store");
    await useThreadSummariesStore.getState().load("parent-1");
    await useThreadSummariesStore.getState().load("parent-1");
    expect(mocks.listThreadSummaries).toHaveBeenCalledTimes(1);
  });

  it("a failure is not recorded as an empty thread list", async () => {
    // The bug: the catch stored `{ summaries: [], loaded: true }`, so one
    // network blip became a permanent "this session has no threads" — the
    // guard then refused to ask again, and nothing in the UI could tell the
    // difference between that and the truth.
    mocks.listThreadSummaries.mockRejectedValueOnce(new Error("offline"));
    const { useThreadSummariesStore } = await import("./thread-summaries-store");
    await useThreadSummariesStore.getState().load("parent-1");
    expect(useThreadSummariesStore.getState().byParent["parent-1"]?.loaded).toBe(false);

    mocks.listThreadSummaries.mockResolvedValueOnce([]);
    await useThreadSummariesStore.getState().load("parent-1");
    expect(mocks.listThreadSummaries).toHaveBeenCalledTimes(2);
  });

  it("a failure keeps whatever was already known", async () => {
    const summary = {
      threadSessionId: "t-1",
      rootMessageId: "m-1",
      title: "Kept",
    } as never;
    mocks.listThreadSummaries.mockResolvedValueOnce([summary]);
    const { useThreadSummariesStore } = await import("./thread-summaries-store");
    await useThreadSummariesStore.getState().load("parent-1");
    expect(useThreadSummariesStore.getState().byParent["parent-1"]?.summaries).toHaveLength(1);

    mocks.listThreadSummaries.mockRejectedValueOnce(new Error("offline"));
    await useThreadSummariesStore.getState().load("parent-1", { force: true });
    expect(useThreadSummariesStore.getState().byParent["parent-1"]?.summaries).toHaveLength(1);
  });
});
