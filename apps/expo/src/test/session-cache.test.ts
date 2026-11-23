import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionsCache, loadTeamSessionsPreferCache } from "../features/sessions/session-cache";
import type { SessionSummary } from "../features/sessions/session-types";
import { createMemoryCacheDb } from "./helpers/memory-db";

function summary(partial: Partial<SessionSummary>): SessionSummary {
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

let db: ReturnType<typeof createMemoryCacheDb>;
let cache: ReturnType<typeof createSessionsCache>;

beforeEach(() => {
  db = createMemoryCacheDb();
  cache = createSessionsCache(async () => db);
});

afterEach(() => {
  db.close();
});

describe("sessions cache", () => {
  it("returns null before anything is cached", async () => {
    // Null, not [] — the list screen shows a spinner for "nothing yet" and an
    // empty state for "cached, genuinely empty".
    expect(await cache.load("t1")).toBeNull();
  });

  it("round-trips a session, arrays and all", async () => {
    await cache.save("t1", [summary({})]);
    const loaded = await cache.load("t1");
    expect(loaded).toEqual([summary({ hasUnread: false })]);
  });

  it("orders by last message, newest first", async () => {
    await cache.save("t1", [
      summary({ sessionId: "old", lastMessageAt: "2026-01-01T00:00:00Z" }),
      summary({ sessionId: "new", lastMessageAt: "2026-06-01T00:00:00Z" }),
    ]);
    const loaded = await cache.load("t1");
    expect(loaded?.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  it("keeps teams apart instead of evicting each other", async () => {
    await cache.save("t1", [summary({ sessionId: "s1", teamId: "t1" })]);
    await cache.save("t2", [summary({ sessionId: "s2", teamId: "t2" })]);
    expect((await cache.load("t1"))?.map((s) => s.sessionId)).toEqual(["s1"]);
    expect((await cache.load("t2"))?.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("replaces a team's scope on save rather than appending", async () => {
    await cache.save("t1", [summary({ sessionId: "s1" }), summary({ sessionId: "s2" })]);
    await cache.save("t1", [summary({ sessionId: "s2" })]);
    expect((await cache.load("t1"))?.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("clears only the requested team", async () => {
    await cache.save("t1", [summary({ sessionId: "s1", teamId: "t1" })]);
    await cache.save("t2", [summary({ sessionId: "s2", teamId: "t2" })]);
    await cache.clear("t1");
    expect(await cache.load("t1")).toBeNull();
    expect((await cache.load("t2"))?.length).toBe(1);
  });

  it("carries the unread flag through the integer column", async () => {
    await cache.save("t1", [summary({ hasUnread: true })]);
    expect((await cache.load("t1"))?.[0]?.hasUnread).toBe(true);
  });

  it("stores past the 200-row ceiling the AsyncStorage blob had", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      summary({
        sessionId: `s${String(i).padStart(4, "0")}`,
        lastMessageAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
      }),
    );
    await cache.save("t1", many);
    expect((await cache.load("t1"))?.length).toBe(250);
  });

  it("ignores a blank team id", async () => {
    await cache.save("", [summary({})]);
    expect(await cache.load("")).toBeNull();
  });
});

describe("loadTeamSessionsPreferCache", () => {
  it("reads the cached rows without touching the network", async () => {
    await cache.save("t1", [summary({ sessionId: "s1" })]);
    const listSessions = async () => {
      throw new Error("network should not be called");
    };
    const rows = await loadTeamSessionsPreferCache("t1", listSessions, cache);
    expect(rows.map((row) => row.sessionId)).toEqual(["s1"]);
  });

  it("falls back to one network walk when nothing is cached", async () => {
    const calls: string[] = [];
    const rows = await loadTeamSessionsPreferCache(
      "t1",
      async (teamId) => {
        calls.push(teamId);
        return [summary({ sessionId: "fresh" })];
      },
      cache,
    );
    expect(calls).toEqual(["t1"]);
    expect(rows.map((row) => row.sessionId)).toEqual(["fresh"]);
  });
});
