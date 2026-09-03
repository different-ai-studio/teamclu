import { describe, expect, it } from "vitest";
import { sortSessionListRows } from "@/lib/session/session-list-sort";

describe("session-list-sort", () => {
  it("orders by last_message_at desc with nulls first", () => {
    const rows = sortSessionListRows([
      { id: "empty-old", last_message_at: null, created_at: "2026-07-21T02:00:00.000Z" },
      { id: "recent", last_message_at: "2026-07-21T10:00:00.000Z", created_at: "2026-07-21T09:00:00.000Z" },
      { id: "empty-new", last_message_at: null, created_at: "2026-07-21T08:00:00.000Z" },
      { id: "older", last_message_at: "2026-07-21T09:00:00.000Z", created_at: "2026-07-21T08:30:00.000Z" },
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      "empty-new",
      "empty-old",
      "recent",
      "older",
    ]);
  });
});
