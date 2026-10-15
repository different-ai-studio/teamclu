import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxDao, OutboxRow } from "../features/sessions/outbox-db";
import { createOutboxSender } from "../features/sessions/outbox-sender";

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    messageId: "m1", sessionId: "s1", teamId: "t1", senderActorId: "a1",
    content: "hi", mentionActorIds: [], replyToMessageId: null,
    attachments: [], state: "pending", attemptCount: 0,
    lastError: null, lastAttemptAt: null, nextAttemptAt: null,
    createdAt: 0, ...overrides,
  };
}

function createFakeDao(): OutboxDao & {
  pending: OutboxRow[];
  delivered: string[];
  failed: { id: string; attempts: number }[];
} {
  const state: OutboxDao & {
    pending: OutboxRow[];
    delivered: string[];
    failed: { id: string; attempts: number }[];
  } = {
    pending: [],
    delivered: [],
    failed: [],
    async enqueue(row) { state.pending.push(makeRow({ ...row, state: "pending" })); },
    async fetchDue() { return state.pending.filter((r) => r.state === "pending"); },
    async markInFlight(id) {
      const row = state.pending.find((r) => r.messageId === id);
      if (row) row.state = "inFlight";
    },
    async markDelivered(id) {
      state.delivered.push(id);
      const row = state.pending.find((r) => r.messageId === id);
      if (row) row.state = "delivered";
    },
    async markFailedRetry(id, attempts, next) {
      const row = state.pending.find((r) => r.messageId === id);
      if (row) { row.state = "pending"; row.attemptCount = attempts; row.nextAttemptAt = next; }
    },
    async markFailedExhausted(id, attempts, _err) {
      state.failed.push({ id, attempts });
      const row = state.pending.find((r) => r.messageId === id);
      if (row) { row.state = "failed"; row.attemptCount = attempts; }
    },
    async retry(id) {
      const row = state.pending.find((r) => r.messageId === id);
      if (row) { row.state = "pending"; row.attemptCount = 0; row.nextAttemptAt = null; }
    },
    async getByMessageId(id) {
      return state.pending.find((r) => r.messageId === id) ?? null;
    },
  };
  return state;
}

describe("OutboxSender", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("delivers a pending row via the send fn", async () => {
    const dao = createFakeDao();
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: 0,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const sender = createOutboxSender({ dao, send, onChange: () => {} });
    sender.start();
    await vi.advanceTimersByTimeAsync(1500);
    sender.stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(dao.delivered).toEqual(["m1"]);
  });

  it("schedules a retry with backoff on send failure", async () => {
    const dao = createFakeDao();
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: 0,
    });
    const send = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(undefined);
    const sender = createOutboxSender({ dao, send, onChange: () => {} });
    sender.start();
    await vi.advanceTimersByTimeAsync(1500); // first attempt → fails, scheduled for +500ms
    expect(dao.pending[0].state).toBe("pending");
    expect(dao.pending[0].attemptCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); // second attempt → succeeds
    sender.stop();
    expect(send).toHaveBeenCalledTimes(2);
    expect(dao.delivered).toEqual(["m1"]);
  });

  it("marks failed after exhausting attempts", async () => {
    const dao = createFakeDao();
    await dao.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: 0,
    });
    const send = vi.fn().mockRejectedValue(new Error("net"));
    const sender = createOutboxSender({ dao, send, onChange: () => {} });
    sender.start();
    // 20 attempts each gated by tick+backoff — fast-forward generously
    await vi.advanceTimersByTimeAsync(20 * 31_000);
    sender.stop();
    expect(dao.failed.length).toBe(1);
    expect(dao.failed[0].attempts).toBeGreaterThanOrEqual(20);
  });

  it("sends a newly enqueued row immediately instead of waiting for the tick", async () => {
    const dao = createFakeDao();
    const send = vi.fn().mockResolvedValue(undefined);
    const sender = createOutboxSender({ dao, send, onChange: () => {}, tickMs: 60_000 });
    sender.start();
    await sender.enqueue({
      messageId: "m1", sessionId: "s", teamId: "t", senderActorId: "a",
      content: "hi", mentionActorIds: [], replyToMessageId: null,
      attachments: [], createdAt: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    sender.stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(dao.delivered).toEqual(["m1"]);
  });

  it("never sends a row twice when a wake lands during a pass", async () => {
    const dao = createFakeDao();
    let release: () => void = () => {};
    const send = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const sender = createOutboxSender({ dao, send, onChange: () => {}, tickMs: 60_000 });
    sender.start();
    const base = {
      sessionId: "s", teamId: "t", senderActorId: "a", content: "hi",
      mentionActorIds: [], replyToMessageId: null, attachments: [], createdAt: 0,
    };
    await sender.enqueue({ ...base, messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    await sender.enqueue({ ...base, messageId: "m2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    sender.stop();
    expect(send.mock.calls.map((c) => (c as unknown as [{ messageId: string }])[0].messageId)).toEqual(["m1", "m2"]);
    expect(dao.delivered).toEqual(["m1", "m2"]);
  });
});
