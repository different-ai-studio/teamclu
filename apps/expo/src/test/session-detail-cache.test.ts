import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionDetailCache } from "../features/sessions/session-detail-cache";
import { createSessionsCache } from "../features/sessions/session-cache";
import type { SessionMessage, SessionSummary } from "../features/sessions/session-types";
import { createMemoryCacheDb } from "./helpers/memory-db";
import { loadMessages } from "../lib/db/local-cache";

function session(partial: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    teamId: "t1",
    title: "Session",
    summary: "",
    participantCount: 2,
    participantActorIds: ["a1", "a2"],
    lastMessagePreview: "hello",
    lastMessageAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "a1",
    ...partial,
  };
}

function message(partial: Partial<SessionMessage> = {}): SessionMessage {
  return {
    messageId: "m1",
    sessionId: "s1",
    teamId: "t1",
    senderActorId: "a1",
    kind: "text",
    content: "hello",
    model: "",
    turnId: "",
    replyToMessageId: "",
    metadata: null,
    createdAt: "2026-01-01T00:00:00Z",
    attachments: [],
    ...partial,
  };
}

let db: ReturnType<typeof createMemoryCacheDb>;
let cache: ReturnType<typeof createSessionDetailCache>;

beforeEach(() => {
  db = createMemoryCacheDb();
  cache = createSessionDetailCache(async () => db);
});

afterEach(() => {
  db.close();
});

describe("session detail cache", () => {
  it("returns null for a session it has never seen", async () => {
    expect(await cache.load("nope")).toBeNull();
  });

  it("round-trips the session and its timeline", async () => {
    await cache.save("s1", { session: session(), messages: [message()] });
    const loaded = await cache.load("s1");
    expect(loaded?.session.title).toBe("Session");
    expect(loaded?.messages).toEqual([message()]);
  });

  it("keeps metadata and attachments through the JSON columns", async () => {
    const rich = message({
      metadata: { tool: "bash", exitCode: 0 },
      attachments: [{ url: "https://example.test/a.png", mime: "image/png" }],
    });
    await cache.save("s1", { session: session(), messages: [rich] });
    const loaded = await cache.load("s1");
    expect(loaded?.messages[0]?.metadata).toEqual({ tool: "bash", exitCode: 0 });
    expect(loaded?.messages[0]?.attachments).toEqual([
      { url: "https://example.test/a.png", mime: "image/png" },
    ]);
  });

  it("rewrites only the rows that changed while the timeline only grows", async () => {
    const m1 = message({ messageId: "m1", createdAt: "2026-01-01T00:00:01Z" });
    const m2 = message({ messageId: "m2", content: "draft", createdAt: "2026-01-01T00:00:02Z" });
    await cache.save("s1", { session: session(), messages: [m1, m2] });

    const runs = vi.spyOn(db, "runAsync");
    const m2Edited = { ...m2, content: "final" };
    const m3 = message({ messageId: "m3", createdAt: "2026-01-01T00:00:03Z" });
    await cache.saveMessages("s1", [m1, m2Edited, m3]);
    const statements = runs.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(2);
    expect(statements.some((sql) => sql.startsWith("DELETE"))).toBe(false);
    runs.mockRestore();

    const loaded = await cache.load("s1");
    expect(loaded?.messages.map((m) => [m.messageId, m.content])).toEqual([
      ["m1", "hello"],
      ["m2", "final"],
      ["m3", "hello"],
    ]);
  });

  it("replaces the whole scope once a message is gone", async () => {
    const m1 = message({ messageId: "m1", createdAt: "2026-01-01T00:00:01Z" });
    const m2 = message({ messageId: "m2", createdAt: "2026-01-01T00:00:02Z" });
    await cache.save("s1", { session: session(), messages: [m1, m2] });
    await cache.saveMessages("s1", [m1]);
    const loaded = await cache.load("s1");
    expect(loaded?.messages.map((m) => m.messageId)).toEqual(["m1"]);
  });

  it("orders the timeline oldest-first", async () => {
    await cache.save("s1", {
      session: session(),
      messages: [
        message({ messageId: "m2", createdAt: "2026-01-02T00:00:00Z" }),
        message({ messageId: "m1", createdAt: "2026-01-01T00:00:00Z" }),
      ],
    });
    const loaded = await cache.load("s1");
    expect(loaded?.messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  it("does not evict the list cache when a detail screen saves", async () => {
    // The two caches share the `cached_sessions` scope. A blind scope replace
    // here would empty the sessions list every time a session was opened.
    const list = createSessionsCache(async () => db);
    await list.save("t1", [
      session({ sessionId: "s1" }),
      session({ sessionId: "s2" }),
      session({ sessionId: "s3" }),
    ]);
    await cache.save("s1", { session: session({ title: "Renamed" }), messages: [] });
    const after = await list.load("t1");
    expect(after?.map((s) => s.sessionId).sort()).toEqual(["s1", "s2", "s3"]);
    expect(after?.find((s) => s.sessionId === "s1")?.title).toBe("Renamed");
  });

  it("replaces a session's timeline rather than appending to it", async () => {
    await cache.save("s1", {
      session: session(),
      messages: [message({ messageId: "m1" }), message({ messageId: "m2" })],
    });
    await cache.saveMessages("s1", [message({ messageId: "m2" })]);
    expect((await cache.load("s1"))?.messages.map((m) => m.messageId)).toEqual(["m2"]);
  });

  it("keeps sessions' timelines apart", async () => {
    await cache.save("s1", {
      session: session({ sessionId: "s1" }),
      messages: [message({ messageId: "m1", sessionId: "s1" })],
    });
    await cache.save("s2", {
      session: session({ sessionId: "s2" }),
      messages: [message({ messageId: "m2", sessionId: "s2" })],
    });
    expect((await cache.load("s1"))?.messages.map((m) => m.messageId)).toEqual(["m1"]);
    expect((await cache.load("s2"))?.messages.map((m) => m.messageId)).toEqual(["m2"]);
  });

  it("keeps more than the 200 messages the blob cache could hold", async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      message({
        messageId: `m${String(i).padStart(4, "0")}`,
        createdAt: `2026-01-01T00:00:00Z`,
      }),
    );
    await cache.save("s1", { session: session(), messages: many });
    expect(await loadMessages(db, "s1")).toHaveLength(500);
  });

  it("reads only the newest rows for the first frame, and a later write keeps the rest", async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      message({
        messageId: `m${String(i).padStart(4, "0")}`,
        createdAt: `2026-01-01T00:00:00Z`,
      }),
    );
    await cache.save("s1", { session: session(), messages: many });

    const fresh = createSessionDetailCache(async () => db);
    const loaded = (await fresh.load("s1"))!.messages;
    expect(loaded).toHaveLength(120);
    expect(loaded[0]?.messageId).toBe("m0380");
    expect(loaded.at(-1)?.messageId).toBe("m0499");

    // The timeline holds only what was loaded, plus a new row and minus one.
    const next = [...loaded.slice(1), message({ messageId: "m0500", createdAt: "2026-01-01T00:00:01Z" })];
    await fresh.saveMessages("s1", next);
    const rows = await loadMessages(db, "s1");
    expect(rows).toHaveLength(500);
    expect(rows.some((row) => row.messageId === "m0380")).toBe(false);
    expect(rows.some((row) => row.messageId === "m0000")).toBe(true);
  });

  it("clears one session's timeline", async () => {
    await cache.save("s1", { session: session(), messages: [message()] });
    await cache.clear("s1");
    // The header row survives — only the timeline is dropped, and a header with
    // no messages is not a usable detail entry.
    expect(await cache.load("s1")).toBeNull();
  });
});
