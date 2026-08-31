import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeWindow } from "../src/report.js";

// Windows are CST-anchored, same as the quota period. A report on a different
// calendar from the enforcement check is how "900 of 1000 used" appears next to
// a refusal.
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

test("day window is one CST day", () => {
  const w = rangeWindow("day", at("2026-08-15T20:00:00Z")); // 2026-08-16 04:00 CST
  assert.equal(iso(w.start), "2026-08-15T16:00:00.000Z");   // 08-16 00:00 CST
  assert.equal(iso(w.end), "2026-08-16T16:00:00.000Z");
});

test("month window spans the CST calendar month", () => {
  const w = rangeWindow("month", at("2026-08-15T10:00:00Z"));
  assert.equal(iso(w.start), "2026-07-31T16:00:00.000Z"); // 08-01 00:00 CST
  assert.equal(iso(w.end), "2026-08-31T16:00:00.000Z");   // 09-01 00:00 CST
});

test("week window is Monday to Monday", () => {
  const w = rangeWindow("week", at("2026-08-27T03:00:00Z"));
  assert.equal(iso(w.start), "2026-08-23T16:00:00.000Z"); // Mon 08-24 00:00 CST
  assert.equal(iso(w.end), "2026-08-30T16:00:00.000Z");
});

test("year window spans the CST calendar year", () => {
  const w = rangeWindow("year", at("2026-08-15T10:00:00Z"));
  assert.equal(iso(w.start), "2025-12-31T16:00:00.000Z");
  assert.equal(iso(w.end), "2026-12-31T16:00:00.000Z");
});

test("windows are half-open so adjacent periods never double-count", () => {
  const aug = rangeWindow("month", at("2026-08-15T10:00:00Z"));
  const sep = rangeWindow("month", at("2026-09-15T10:00:00Z"));
  assert.equal(iso(aug.end), iso(sep.start), "one period's end is the next one's start");
});
