import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return import("../features/sessions/unread-store");
}

describe("unread-store team scoping", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("accepts counts before any team is declared (unscoped callers)", async () => {
    const store = await freshStore();
    store.setUnreadSessionCount(3);
    expect(store.getUnreadSessionCount()).toBe(3);
    store.setUnreadSessionCount(4, "team-a");
    expect(store.getUnreadSessionCount()).toBe(4);
  });

  it("zeroes the badge when the active team changes", async () => {
    const store = await freshStore();
    store.setActiveUnreadTeam("team-a");
    store.setUnreadSessionCount(5, "team-a");
    const listener = vi.fn();
    store.subscribeUnreadSessionCount(listener);

    store.setActiveUnreadTeam("team-b");

    expect(store.getUnreadSessionCount()).toBe(0);
    expect(listener).toHaveBeenCalledWith(0);
  });

  it("drops a late count from the previous team after a switch", async () => {
    const store = await freshStore();
    store.setActiveUnreadTeam("team-a");
    store.setActiveUnreadTeam("team-b");

    // The old team's sessions controller resolving after the switch.
    store.setUnreadSessionCount(9, "team-a");
    expect(store.getUnreadSessionCount()).toBe(0);

    store.setUnreadSessionCount(2, "team-b");
    expect(store.getUnreadSessionCount()).toBe(2);
  });

  it("signing out (no team) clears the badge", async () => {
    const store = await freshStore();
    store.setActiveUnreadTeam("team-a");
    store.setUnreadSessionCount(1, "team-a");
    store.setActiveUnreadTeam(null);
    expect(store.getUnreadSessionCount()).toBe(0);
  });
});

describe("unread-store reports (app icon badge)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("only counts as reported once the active team's list answers", async () => {
    const store = await freshStore();
    store.setActiveUnreadTeam("team-a");
    expect(store.hasUnreadSessionCountReport()).toBe(false);
    store.setUnreadSessionCount(0, "team-a");
    expect(store.hasUnreadSessionCountReport()).toBe(true);
    store.setActiveUnreadTeam("team-b");
    expect(store.hasUnreadSessionCountReport()).toBe(false);
  });

  it("tells report listeners even when the count repeats", async () => {
    const store = await freshStore();
    store.setActiveUnreadTeam("team-a");
    const listener = vi.fn();
    store.subscribeUnreadSessionCountReports(listener);
    store.setUnreadSessionCount(0, "team-a");
    store.setUnreadSessionCount(0, "team-a");
    store.setUnreadSessionCount(9, "team-x");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(0);
  });
});
