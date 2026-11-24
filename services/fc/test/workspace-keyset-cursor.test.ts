import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWorkspaceKeysetCursor } from "../src/lib/supabase-repo.js";
import { ApiError } from "../src/lib/http-utils.js";

function recorder() {
  const calls: Array<[string, ...string[]]> = [];
  const q = {
    or(filter: string) { calls.push(["or", filter]); return q; },
    lt(column: string, value: string) { calls.push(["lt", column, value]); return q; },
  };
  return { q, calls };
}

test("workspace cursor keeps rows that share the last row's updated_at", () => {
  const { q, calls } = recorder();
  applyWorkspaceKeysetCursor(q, {
    updatedAt: "2026-09-17T10:18:45.250065+08:00",
    id: "b490804c-9656-4b96-b9a2-3cb39a24e417",
  });
  assert.deepEqual(calls, [[
    "or",
    'updated_at.lt."2026-09-17T10:18:45.250065+08:00",and(updated_at.eq."2026-09-17T10:18:45.250065+08:00",id.lt."b490804c-9656-4b96-b9a2-3cb39a24e417")',
  ]]);
});

test("workspace cursor without an id falls back to updated_at only", () => {
  const { q, calls } = recorder();
  applyWorkspaceKeysetCursor(q, { updatedAt: "2026-09-17T02:18:45Z", id: null });
  assert.deepEqual(calls, [["lt", "updated_at", "2026-09-17T02:18:45Z"]]);
});

test("workspace cursor refuses values that could break out of the filter", () => {
  const { q } = recorder();
  for (const cursor of [
    { updatedAt: '2026-01-01",id.neq."x', id: "a" },
    { updatedAt: "2026-01-01", id: "a),team_id.neq.(b" },
  ]) {
    assert.throws(() => applyWorkspaceKeysetCursor(q, cursor), (e: unknown) => e instanceof ApiError && e.statusCode === 400);
  }
});
