import { test } from "node:test";
import assert from "node:assert/strict";
import { applyKeysetCursor } from "../src/lib/supabase-repo.js";
import { decodeAppListCursor } from "../src/lib/routes/apps.js";
import { encodeCursor } from "../src/lib/routing-utils.js";
import { ApiError } from "../src/lib/http-utils.js";

function recorder() {
  const calls: Array<[string, ...string[]]> = [];
  const q = {
    or(filter: string) { calls.push(["or", filter]); return q; },
    lt(column: string, value: string) { calls.push(["lt", column, value]); return q; },
  };
  return { q, calls };
}

test("app cursor round-trips the raw created_at, microseconds included", () => {
  const raw = "2026-11-24T03:12:45.123456+00:00";
  const decoded = decodeAppListCursor(encodeCursor({ createdAt: raw, id: "app-1" }));
  assert.deepEqual(decoded, { createdAt: raw, id: "app-1" });
});

test("app cursor pages on (created_at, id) so tied rows are kept", () => {
  const { q, calls } = recorder();
  applyKeysetCursor(q, "created_at", "2026-11-24T03:12:45.123456+00:00", "9f0c");
  assert.deepEqual(calls, [[
    "or",
    'created_at.lt."2026-11-24T03:12:45.123456+00:00",and(created_at.eq."2026-11-24T03:12:45.123456+00:00",id.lt."9f0c")',
  ]]);
});

test("a malformed app cursor is a 400, not a full list", () => {
  for (const bad of ["not-base64-json", encodeCursor({ id: "x" }), encodeCursor({ createdAt: 'x",id.neq."y', id: "a" })]) {
    assert.throws(
      () => {
        const c = decodeAppListCursor(bad);
        applyKeysetCursor(recorder().q, "created_at", c!.createdAt, c!.id);
      },
      (e: unknown) => e instanceof ApiError && e.statusCode === 400,
    );
  }
});
