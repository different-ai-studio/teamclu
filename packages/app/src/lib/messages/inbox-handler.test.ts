import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mqtt/mqtt-bridge", () => ({
  mqttSubscribe: subscribeMock,
}));

const shouldMarkSessionUnreadMock = vi.hoisted(() => vi.fn(() => true));
const scheduleMarkActiveSessionReadMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session/active-session-read", () => ({
  shouldMarkSessionUnread: shouldMarkSessionUnreadMock,
  scheduleMarkActiveSessionRead: scheduleMarkActiveSessionReadMock,
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
} from "@/lib/messages/inbox-handler";

function makeEnv(topic: string, payload: unknown): { topic: string; bytes: number[] } {
  const text = JSON.stringify(payload);
  return { topic, bytes: Array.from(new TextEncoder().encode(text)) };
}

function makeStore(rowIds: string[]): InboxStore & {
  patchRow: ReturnType<typeof vi.fn>;
  loadFirstPage: ReturnType<typeof vi.fn>;
  noteInboxMessage: ReturnType<typeof vi.fn>;
  clearSessionAttention: ReturnType<typeof vi.fn>;
} {
  return {
    rows: rowIds.map((id) => ({ id })),
    patchRow: vi.fn(),
    loadFirstPage: vi.fn(async () => {}),
    noteInboxMessage: vi.fn(),
    clearSessionAttention: vi.fn(),
  };
}

describe("handleInboxEnvelope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInboxListRefreshForTests();
    shouldMarkSessionUnreadMock.mockReset();
    shouldMarkSessionUnreadMock.mockReturnValue(true);
    scheduleMarkActiveSessionReadMock.mockReset();
  });

  afterEach(() => {
    resetInboxListRefreshForTests();
    vi.useRealTimers();
  });

  it("notes attention and debounces kind-scoped reload", () => {
    const store = makeStore(["s1", "s2"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", {
        session_id: "s1",
        kind: "channel",
        mentioned: true,
        ts: 12345,
      }),
      "u1",
      store,
    );
    expect(store.noteInboxMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      kind: "channel",
      mentioned: true,
    });
    expect(store.loadFirstPage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledWith(50, "channel");
  });

  it("debounces list reload for an unknown session when kind is present", () => {
    const store = makeStore(["s1"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "newsession", kind: "regular" }),
      "u1",
      store,
    );
    expect(store.noteInboxMessage).toHaveBeenCalledWith({
      sessionId: "newsession",
      kind: "regular",
      mentioned: false,
    });
    expect(store.loadFirstPage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledWith(50, "regular");
  });

  it("falls back to legacy unread when kind is missing", () => {
    const store = makeStore(["s1"]);
    handleInboxEnvelope(makeEnv("inbox/u1", { session_id: "s1" }), "u1", store);
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
    expect(store.patchRow).toHaveBeenCalledWith("s1", { has_unread: true });
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledWith(50, undefined);
  });

  it("legacy missing-kind still refreshes for unknown sessions", () => {
    const store = makeStore(["s1"]);
    const onMessagePing = vi.fn();
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "newsession" }),
      "u1",
      store,
      console,
      { onMessagePing },
    );
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
    expect(store.patchRow).not.toHaveBeenCalled();
    expect(onMessagePing).toHaveBeenCalledWith("newsession");
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledWith(50, undefined);
  });

  it("coalesces burst pings into a single list reload", () => {
    const store = makeStore(["s1", "s2"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", kind: "regular" }),
      "u1",
      store,
    );
    vi.advanceTimersByTime(100);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s2", kind: "channel" }),
      "u1",
      store,
    );
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).toHaveBeenCalledOnce();
    expect(store.loadFirstPage).toHaveBeenCalledWith(50, "channel");
  });

  it("ignores pings for a different user (defensive, broker ACL should also block)", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      makeEnv("inbox/other-user", { session_id: "s1", kind: "regular" }),
      "u1",
      store,
      logger,
    );
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("silently ignores non-inbox topics (other MQTT traffic flows through same listener)", () => {
    const store = makeStore(["s1"]);
    const logger = { warn: vi.fn() };
    handleInboxEnvelope(
      makeEnv("amux/t1/session/s1/live", { session_id: "s1", kind: "regular" }),
      "u1",
      store,
      logger,
    );
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
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
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
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
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("calls onMessagePing for message pings but not read pings", () => {
    const store = makeStore(["s1"]);
    const onMessagePing = vi.fn();
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", type: "message", kind: "regular" }),
      "u1",
      store,
      console,
      { onMessagePing },
    );
    expect(onMessagePing).toHaveBeenCalledWith("s1");

    onMessagePing.mockClear();
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", type: "read" }),
      "u1",
      store,
      console,
      { onMessagePing },
    );
    expect(onMessagePing).not.toHaveBeenCalled();
    expect(store.clearSessionAttention).toHaveBeenCalledWith("s1");
  });

  it("handles a roster hint before unread and message side effects", () => {
    const store = makeStore(["s1"]);
    const onMessagePing = vi.fn();
    const onParticipantsChanged = vi.fn();
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", team_id: "team-1", type: "session.participants" }),
      "u1",
      store,
      console,
      { onMessagePing, onParticipantsChanged },
    );
    expect(onParticipantsChanged).toHaveBeenCalledWith("s1", "team-1");
    expect(onMessagePing).not.toHaveBeenCalled();
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INBOX_LIST_REFRESH_MS);
    expect(store.loadFirstPage).not.toHaveBeenCalled();

    onParticipantsChanged.mockClear();
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", type: "session.participants" }),
      "u1",
      store,
      console,
      { onParticipantsChanged },
    );
    expect(onParticipantsChanged).not.toHaveBeenCalled();
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
  });

  it("marks active session read instead of noting attention on message ping", () => {
    shouldMarkSessionUnreadMock.mockReturnValue(false);
    const store = makeStore(["s1"]);
    handleInboxEnvelope(
      makeEnv("inbox/u1", { session_id: "s1", kind: "app", mentioned: true }),
      "u1",
      store,
    );
    expect(store.noteInboxMessage).not.toHaveBeenCalled();
    expect(scheduleMarkActiveSessionReadMock).toHaveBeenCalled();
  });
});

describe("ensureInboxSubscribed", () => {
  beforeEach(() => {
    resetInboxSubscriptionState();
    subscribeMock.mockReset();
    subscribeMock.mockResolvedValue(undefined);
  });

  it("subscribes once per user", async () => {
    await ensureInboxSubscribed("u1");
    await ensureInboxSubscribed("u1");
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith("inbox/u1");
  });
});
