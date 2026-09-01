import { test } from "node:test";
import assert from "node:assert/strict";
import { periodStart } from "../src/period.js";

// Anchored to Asia/Shanghai. The usage report and the quota check share this
// function precisely so a member cannot see "900 of 1000 used" on the billing
// screen while the gateway refuses their next request.
const at = (iso: string) => new Date(iso);

test("month starts on the 1st at 00:00 CST", () => {
  assert.equal(periodStart("month", at("2026-08-15T10:00:00Z")).toISOString(),
    "2026-07-31T16:00:00.000Z"); // = 2026-08-01 00:00 +08:00
});

test("a UTC instant late on the last day is already the next CST month", () => {
  // 2026-08-31T17:00Z is 2026-09-01 01:00 CST — the boundary case a naive UTC
  // truncation gets wrong, charging the request to the wrong period.
  assert.equal(periodStart("month", at("2026-08-31T17:00:00Z")).toISOString(),
    "2026-08-31T16:00:00.000Z"); // = 2026-09-01 00:00 +08:00
});

test("week starts Monday 00:00 CST", () => {
  // 2026-08-27 is a Thursday in CST; its week began Monday 2026-08-24.
  assert.equal(periodStart("week", at("2026-08-27T03:00:00Z")).toISOString(),
    "2026-08-23T16:00:00.000Z"); // = 2026-08-24 00:00 +08:00
});

test("Sunday belongs to the week that began the previous Monday", () => {
  // The off-by-one that a 0=Sunday day index invites: Sunday must look back
  // six days, not forward one.
  const sundayCst = at("2026-08-30T04:00:00Z"); // Sunday 12:00 CST
  assert.equal(periodStart("week", sundayCst).toISOString(), "2026-08-23T16:00:00.000Z");
});

test("an instant exactly on the boundary belongs to the new period", () => {
  const boundary = at("2026-07-31T16:00:00Z"); // 2026-08-01 00:00 CST
  assert.equal(periodStart("month", boundary).toISOString(), boundary.toISOString());
});
