import { describe, expect, it } from "vitest";

import {
  lastContactByActor,
  loadLastContactByActor,
  orderActorsForPicker,
} from "../features/sessions/actor-picker-ordering";

const rows = [
  { actorId: "a", displayName: "Alice" },
  { actorId: "b", displayName: "Bob" },
  { actorId: "c", displayName: "Carol" },
  { actorId: "d", displayName: "Dave" },
];

function order(pinned: string | null, contact: Record<string, number>, items = rows) {
  return orderActorsForPicker(items, pinned, new Map(Object.entries(contact))).map((r) => r.actorId);
}

describe("orderActorsForPicker (iOS #1602)", () => {
  it("pins the default agent, then orders by recent contact, then by name", () => {
    const now = 1_000_000;
    expect(order("c", { b: now - 60, d: now, c: now - 3600 })).toEqual(["c", "d", "b", "a"]);
  });

  it("keeps a pinned actor first even with no contact", () => {
    expect(order("d", { a: 5 })).toEqual(["d", "a", "b", "c"]);
  });

  it("is alphabetical without pin or contact", () => {
    expect(order(null, {}, [rows[2], rows[0], rows[3], rows[1]])).toEqual(["a", "b", "c", "d"]);
  });
});

describe("lastContactByActor", () => {
  it("keeps the newest message per actor", () => {
    const map = lastContactByActor([
      { actorId: "a", at: "2026-10-01T00:00:00Z" },
      { actorId: "a", at: "2026-10-02T00:00:00Z" },
      { actorId: "b", at: "2026-10-01T00:00:00Z" },
      { actorId: "c", at: "not a date" },
    ]);
    expect(map.get("a")).toBe(Date.parse("2026-10-02T00:00:00Z"));
    expect(map.get("b")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(map.has("c")).toBe(false);
  });
});

describe("loadLastContactByActor", () => {
  it("reads the newest cached message per sender for the team", async () => {
    const calls: unknown[][] = [];
    const db = {
      runAsync: async () => undefined,
      getAllAsync: async (...args: unknown[]) => {
        calls.push(args);
        return [{ sender_actor_id: "a", last_at: "2026-10-02T00:00:00Z" }];
      },
    };
    const map = await loadLastContactByActor(db, "team-1");
    expect(calls[0]?.[1]).toBe("team-1");
    expect(map.get("a")).toBe(Date.parse("2026-10-02T00:00:00Z"));
  });

  it("falls back to no contacts when the cache can't be read", async () => {
    const db = {
      runAsync: async () => undefined,
      getAllAsync: async () => {
        throw new Error("no such table");
      },
    };
    expect((await loadLastContactByActor(db, "team-1")).size).toBe(0);
  });
});
