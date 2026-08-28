import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mqtt-bridge", () => ({
  mqttSubscribe: subscribeMock,
}));

const shouldMarkSessionUnreadMock = vi.hoisted(() => vi.fn(() => true));
const scheduleMarkActiveSessionReadMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/active-session-read", () => ({
  shouldMarkSessionUnread: shouldMarkSessionUnreadMock,
  scheduleMarkActiveSessionRead: scheduleMarkActiveSessionReadMock,
}));

const requestDockAttentionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/notification-service", () => ({
  notificationService: {
    requestDockAttention: requestDockAttentionMock,
  },
}));

import {
  ensureInboxSubscribed,
  handleInboxEnvelope,
  INBOX_LIST_REFRESH_MS,
  resetInboxListRefreshForTests,
  resetInboxSubscriptionState,
  scheduleSessionListRefresh,
  SESSION_LIST_REFRESH_MS,
  type InboxStore,
} from "./inbox-handler";

function makeEnv(topic: string, payload: unknown): { topic: string; bytes: number[] } {
  const text = JSON.stringify(payload);
  return { topic, bytes: Array.from(new TextEncoder().encode(text)) };
}

function makeStore(rowIds: string[]): InboxStore & {
  patchRow: ReturnType<typeof vi.fn>;
  loadFirstPage: ReturnType<typeof vi.fn>;
} {
  return {
    rows: rowIds.map((id) => ({ id })),
    patchRow: vi.fn(),
    loadFirstPage: vi.fn(async () => {}),
  };
}

describe("handleInboxEnvelope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInboxListRefreshForTests();
    shouldMarkSessionUnreadMock.mockReset();
    shouldMarkSessionUnreadMock.mockReturnValue(true);
    scheduleMarkActiveSessionReadMock.mockReset();
    requestDockAttentionMock.mockClear();
  });

  afterEach(() => {
    resetInboxListRefreshForTests();
    vi.useRealTimers();
  });

  it("patches has_unread immediately and debounces list reload for cached sessions", () => {
    const store = makeStore(["s1", "s2"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", ts: 12345 }),
      "u1",
      store,
    );
    expect(store.patchRow).toHaveBeenCalledWith("s1", { has_unread: true });
    expect(store.loadFirstPage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledOnce();
  });

  it("debounces list reload when session is not in cache", () => {
    const store = makeStore(["s1"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "newsession" }),
      "u1",
      store,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(store.loadFirstPage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledOnce();
  });

  it("coalesces burst pings into a single list reload", () => {
    const store = makeStore(["s1", "s2"]);
    handleInboxEnvelope(makeEnv("inbox/u1", { session_id: "s1" }), "u1", store);
    vi.advanceTimersByTime(100);
    handleInboxEnvelope(makeEnv("inbox/u1", { session_id: "s2" }), "u1", store);
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledOnce();
  });

  it("ignores pings for a different user (defensive, broker ACL should also block)", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      makeEnv("inbox/other-user", { session_id: "s1" }),
      "u1",
      store,
      logger,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("silently ignores non-inbox topics (other MQTT traffic flows through same listener)", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      makeEnv("amux/t1/session/s1/live", { session_id: "s1" }),
      "u1",
      store,
      logger,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns on unparseable payload", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      { topic: "inbox/u1", bytes: [0xff, 0xfe, 0xfd, 0x00] },
      "u1",
      store,
      logger,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("scheduleSessionListRefresh debounces loadFirstPage", () => {
    const loadFirstPage = vi.fn(async () => {});
    scheduleSessionListRefresh(loadFirstPage);
    expect(loadFirstPage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SESSION_LIST_REFRESH_MS);
    expect(loadFirstPage).toHaveBeenCalledOnce();
  });

  it("scheduleSessionListRefresh coalesces burst calls", () => {
    const loadFirstPage = vi.fn(async () => {});
    scheduleSessionListRefresh(loadFirstPage);
    vi.advanceTimersByTime(100);
    scheduleSessionListRefresh(loadFirstPage);
    vi.advanceTimersByTime(SESSION_LIST_REFRESH_MS);
    expect(loadFirstPage).toHaveBeenCalledOnce();
  });

  it("warns on payload missing session_id", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(makeEnv("inbox/u1", { ts: 123 }), "u1", store, logger);
    expect(store.patchRow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("calls onMessagePing for message pings but not read pings", () => {
    const store = makeStore(["s1"]);
    const onMessagePing = vi.fn();
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", type: "message" }),
      "u1",
      store,
      console,
      { onMessagePing },
    );
    expect(onMessagePing).toHaveBeenCalledWith("s1");
    expect(requestDockAttentionMock).toHaveBeenCalledOnce();

    onMessagePing.mockClear();
    requestDockAttentionMock.mockClear();
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", type: "read" }),
      "u1",
      store,
      console,
      { onMessagePing },
    );
    expect(onMessagePing).not.toHaveBeenCalled();
    expect(requestDockAttentionMock).not.toHaveBeenCalled();
  });

  it("marks active session read instead of patching unread on message ping", () => {
    shouldMarkSessionUnreadMock.mockReturnValue(false);
    const store = makeStore(["s1"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", type: "message" }),
      "u1",
      store,
    );
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(scheduleMarkActiveSessionReadMock).toHaveBeenCalledWith(
      "s1",
      null,
      expect.objectContaining({ afterMarkRead: expect.any(Function) }),
    );
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).not.toHaveBeenCalled();
  });
});

describe("ensureInboxSubscribed", () => {
  beforeEach(() => {
    subscribeMock.mockReset();
    subscribeMock.mockResolvedValue(undefined);
    resetInboxSubscriptionState();
  });

  it("re-subscribes after resetInboxSubscriptionState (broker reconnect)", async () => {
    await ensureInboxSubscribed("user-1");
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    subscribeMock.mockClear();

    resetInboxSubscriptionState();
    await ensureInboxSubscribed("user-1");

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith("inbox/user-1");
  });

  it("ignores stale subscribe that completes after reset", async () => {
    let resolveStale!: () => void;
    subscribeMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveStale = resolve; }),
    );
    subscribeMock.mockResolvedValue(undefined);

    const stale = ensureInboxSubscribed("user-1");
    resetInboxSubscriptionState();
    await ensureInboxSubscribed("user-1");

    resolveStale();
    await stale;

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock).toHaveBeenNthCalledWith(2, "inbox/user-1");
  });
});
