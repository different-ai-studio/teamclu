import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn();

vi.mock("@/lib/mqtt-bridge", () => ({
  mqttSubscribe: subscribeMock,
  mqttUnsubscribe: unsubscribeMock,
}));

const {
  collectInboxIdleInterestSessionIds,
  collectSessionsNeedingLiveInterest,
  ensureSessionLiveSubscribed,
  isSessionLiveInterest,
  mergeSessionLiveInterestIds,
  noteInboxOpenedSession,
  pruneIdleInboxSessions,
  resetInboxIdleInterestForTests,
  resetSessionLiveInterestForTests,
  resetSessionLiveSubscriptionStateForTests,
  resubscribeSessionLiveInterest,
  SESSION_LIVE_IDLE_UNSUB_MS,
  syncSessionLiveInterest,
  touchLiveEventActivity,
} = await import("./session-live-subscriptions");

beforeEach(() => {
  subscribeMock.mockReset();
  unsubscribeMock.mockReset();
  resetSessionLiveSubscriptionStateForTests();
  resetSessionLiveInterestForTests();
  resetInboxIdleInterestForTests();
  subscribeMock.mockResolvedValue(undefined);
  unsubscribeMock.mockResolvedValue(undefined);
});

describe("session live subscriptions", () => {
  it("subscribes to concrete session topics", async () => {
    await ensureSessionLiveSubscribed("team-1", "session-1");

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith("amux/team-1/session/session-1/live");
    expect(isSessionLiveInterest("session-1")).toBe(true);
  });

  it("ensureSessionLiveSubscribed marks interest before SUB completes", async () => {
    let resolveSubscribe!: () => void;
    subscribeMock.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSubscribe = resolve; }),
    );

    const subPromise = ensureSessionLiveSubscribed("team-1", "session-1");
    expect(isSessionLiveInterest("session-1")).toBe(true);

    resolveSubscribe();
    await subPromise;
  });

  it("syncSessionLiveInterest subscribes each requested TeamClu session", async () => {
    await syncSessionLiveInterest("team-1", ["session-1", "session-2"]);

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(isSessionLiveInterest("session-1")).toBe(true);
    expect(isSessionLiveInterest("session-2")).toBe(true);
    expect(isSessionLiveInterest("other")).toBe(false);
  });

  it("syncSessionLiveInterest marks interest before SUB completes", async () => {
    let resolveSubscribe!: () => void;
    subscribeMock.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSubscribe = resolve; }),
    );

    const syncPromise = syncSessionLiveInterest("team-1", ["session-1"]);
    expect(isSessionLiveInterest("session-1")).toBe(true);

    resolveSubscribe();
    await syncPromise;
  });

  it("syncSessionLiveInterest unsubscribes removed sessions on update", async () => {
    await syncSessionLiveInterest("team-1", ["session-1", "session-2"]);
    subscribeMock.mockClear();

    await syncSessionLiveInterest("team-1", ["session-2", "session-3"]);

    expect(unsubscribeMock).toHaveBeenCalledWith("amux/team-1/session/session-1/live");
    expect(subscribeMock).toHaveBeenCalledWith("amux/team-1/session/session-3/live");
    expect(isSessionLiveInterest("session-1")).toBe(false);
    expect(isSessionLiveInterest("session-3")).toBe(true);
  });

  it("syncSessionLiveInterest(null, []) releases all subscriptions", async () => {
    await syncSessionLiveInterest("team-1", ["session-1"]);
    unsubscribeMock.mockClear();

    await syncSessionLiveInterest(null, []);

    expect(unsubscribeMock).toHaveBeenCalledWith("amux/team-1/session/session-1/live");
    expect(isSessionLiveInterest("session-1")).toBe(false);
  });

  it("resubscribes interest set after subscription state reset", async () => {
    await syncSessionLiveInterest("team-1", ["session-1"]);
    resetSessionLiveSubscriptionStateForTests();
    subscribeMock.mockClear();

    await resubscribeSessionLiveInterest();

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith("amux/team-1/session/session-1/live");
  });

  it("collectSessionsNeedingLiveInterest includes active and pending-permission sessions", () => {
    const ids = collectSessionsNeedingLiveInterest({
      a: {
        sessionId: "session-a",
        active: true,
        pendingPermissionsByRequestId: {},
      },
      b: {
        sessionId: "session-b",
        active: false,
        pendingPermissionsByRequestId: { req1: {} },
      },
      c: {
        sessionId: "session-c",
        active: false,
        pendingPermissionsByRequestId: {},
      },
    });
    expect(ids.sort()).toEqual(["session-a", "session-b"].sort());
  });

  it("syncSessionLiveInterest ignores stale run that finishes after a newer sync", async () => {
    let resolveFirst!: () => void;
    subscribeMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveFirst = resolve; }),
    );
    subscribeMock.mockResolvedValue(undefined);

    const stale = syncSessionLiveInterest("team-1", ["session-old"]);
    await syncSessionLiveInterest("team-1", ["session-new"]);

    resolveFirst();
    await stale;

    expect(isSessionLiveInterest("session-new")).toBe(true);
    expect(isSessionLiveInterest("session-old")).toBe(false);
  });
});

describe("inbox-triggered idle interest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("noteInboxOpenedSession keeps session in idle interest within 1h", () => {
    noteInboxOpenedSession("session-inbox");
    const pinned = new Set<string>();
    expect(collectInboxIdleInterestSessionIds(pinned)).toEqual(["session-inbox"]);
  });

  it("drops inbox-opened session after 1h without live events", () => {
    noteInboxOpenedSession("session-inbox");
    vi.advanceTimersByTime(SESSION_LIVE_IDLE_UNSUB_MS + 1);
    expect(collectInboxIdleInterestSessionIds(new Set())).toEqual([]);
    expect(pruneIdleInboxSessions(new Set())).toBe(true);
    expect(collectInboxIdleInterestSessionIds(new Set())).toEqual([]);
  });

  it("touchLiveEventActivity extends idle deadline", () => {
    noteInboxOpenedSession("session-inbox");
    vi.advanceTimersByTime(SESSION_LIVE_IDLE_UNSUB_MS - 1000);
    touchLiveEventActivity("session-inbox");
    vi.advanceTimersByTime(2000);
    expect(collectInboxIdleInterestSessionIds(new Set())).toEqual(["session-inbox"]);
    vi.advanceTimersByTime(SESSION_LIVE_IDLE_UNSUB_MS);
    expect(collectInboxIdleInterestSessionIds(new Set())).toEqual([]);
  });

  it("pinned sessions are excluded from inbox idle collect but stay via merge", () => {
    noteInboxOpenedSession("session-pinned");
    vi.advanceTimersByTime(SESSION_LIVE_IDLE_UNSUB_MS + 1);
    const pinned = new Set(["session-pinned"]);
    expect(collectInboxIdleInterestSessionIds(pinned)).toEqual([]);
    expect(mergeSessionLiveInterestIds("session-pinned", [])).toEqual(["session-pinned"]);
    expect(pruneIdleInboxSessions(pinned)).toBe(false);
  });

  it("mergeSessionLiveInterestIds unions foreground, background, and inbox idle", () => {
    noteInboxOpenedSession("session-inbox");
    const ids = mergeSessionLiveInterestIds("session-active", ["session-stream"]);
    expect(ids.sort()).toEqual(["session-active", "session-inbox", "session-stream"].sort());
  });
});
