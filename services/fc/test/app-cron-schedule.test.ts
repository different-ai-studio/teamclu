import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTimeZone,
  computeNextRun,
  parseCronExpression,
} from "../src/lib/app-cron-schedule.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// --- parsing ----------------------------------------------------------------

test("a five-field expression parses into the values it admits", () => {
  const f = parseCronExpression("0 9 * * 1-5");
  assert.deepEqual([...f.minute], [0]);
  assert.deepEqual([...f.hour], [9]);
  assert.deepEqual([...f.dayOfWeek].sort(), [1, 2, 3, 4, 5]);
  assert.equal(f.dayOfMonthRestricted, false);
  assert.equal(f.dayOfWeekRestricted, true);
});

test("steps, ranges and lists all reach the same set", () => {
  assert.deepEqual([...parseCronExpression("*/15 * * * *").minute], [0, 15, 30, 45]);
  assert.deepEqual([...parseCronExpression("0,15,30,45 * * * *").minute], [0, 15, 30, 45]);
  assert.deepEqual([...parseCronExpression("0-45/15 * * * *").minute], [0, 15, 30, 45]);
});

test("month and weekday names are accepted", () => {
  const f = parseCronExpression("0 0 1 JAN MON");
  assert.deepEqual([...f.month], [1]);
  assert.deepEqual([...f.dayOfWeek], [1]);
});

test("both spellings of Sunday land on the same value", () => {
  assert.deepEqual([...parseCronExpression("0 0 * * 0").dayOfWeek], [0]);
  assert.deepEqual([...parseCronExpression("0 0 * * 7").dayOfWeek], [0]);
});

test("a bare * leaves the field unrestricted but a stepped * does not", () => {
  // The distinction decides whether the two day fields are unioned.
  assert.equal(parseCronExpression("0 0 * * *").dayOfWeekRestricted, false);
  assert.equal(parseCronExpression("0 0 * * */2").dayOfWeekRestricted, true);
});

test("expressions that cannot mean anything are refused with a 400", () => {
  for (const expr of [
    "0 9 * *", // four fields
    "0 9 * * * *", // six
    "60 * * * *", // minute out of range
    "* 24 * * *", // hour out of range
    "0 0 0 * *", // day-of-month is 1-based
    "0 0 * 13 *", // month out of range
    "0 0 * * 8", // weekday out of range
    "5-1 * * * *", // backwards range
    "*/0 * * * *", // zero step
    "a * * * *", // not a number
    "0 0 * * MONDAY", // not a three-letter name
  ]) {
    assert.throws(
      () => parseCronExpression(expr),
      (e: any) => e.statusCode === 400,
      `accepted ${expr}`,
    );
  }
});

test("an unknown timezone is a 400, not a silent fallback to UTC", () => {
  assert.throws(() => assertTimeZone("Mars/Olympus"), (e: any) => e.statusCode === 400);
  assert.doesNotThrow(() => assertTimeZone("Asia/Shanghai"));
});

// --- next run ---------------------------------------------------------------

test("the next run is strictly after the instant asked about", () => {
  // Exactly on the minute: the answer must be tomorrow, not this same instant,
  // or a tick would immediately re-claim the job it just ran.
  const at9 = new Date("2026-09-10T09:00:00.000Z");
  assert.equal(iso(computeNextRun("0 9 * * *", "UTC", at9)), "2026-09-11T09:00:00.000Z");
  const before = new Date("2026-09-10T08:59:59.000Z");
  assert.equal(iso(computeNextRun("0 9 * * *", "UTC", before)), "2026-09-10T09:00:00.000Z");
});

test("a timezone shifts the instant, not the wall clock the user typed", () => {
  // 09:00 in Shanghai is 01:00 UTC.
  const from = new Date("2026-09-10T00:00:00.000Z");
  assert.equal(
    iso(computeNextRun("0 9 * * *", "Asia/Shanghai", from)),
    "2026-09-10T01:00:00.000Z",
  );
});

test("every minute means the next minute", () => {
  const from = new Date("2026-09-10T09:30:20.000Z");
  assert.equal(iso(computeNextRun("* * * * *", "UTC", from)), "2026-09-10T09:31:00.000Z");
});

test("weekday schedules skip the weekend", () => {
  // 2026-09-11 is a Friday; the next weekday run is Monday the 14th.
  const friday = new Date("2026-09-11T09:00:00.000Z");
  assert.equal(
    iso(computeNextRun("0 9 * * 1-5", "UTC", friday)),
    "2026-09-14T09:00:00.000Z",
  );
});

test("restricting BOTH day fields unions them, as cron has always done", () => {
  // "the 1st, and every Monday" — not "Mondays that fall on the 1st".
  const from = new Date("2026-09-10T00:00:00.000Z"); // Thursday
  assert.equal(
    iso(computeNextRun("0 0 1 * MON", "UTC", from)),
    "2026-09-14T00:00:00.000Z", // Monday the 14th, before the 1st of October
  );
});

test("a date that never comes has no next run rather than a wrong one", () => {
  // Feb 30 exists in no year. Null is what the column stores as "never again".
  assert.equal(computeNextRun("0 0 30 2 *", "UTC", new Date("2026-01-01T00:00:00Z")), null);
});

test("Feb 29 is found, which is why the search reaches four years out", () => {
  const from = new Date("2026-03-01T00:00:00.000Z");
  assert.equal(
    iso(computeNextRun("0 0 29 2 *", "UTC", from)),
    "2028-02-29T00:00:00.000Z",
  );
});

// --- daylight saving --------------------------------------------------------

test("a time inside the spring-forward gap is skipped, not invented", () => {
  // America/New_York jumps 02:00 → 03:00 on 2026-03-08. A 02:30 job does not
  // run that day; the next occurrence is the 9th.
  const from = new Date("2026-03-07T12:00:00.000Z");
  const next = computeNextRun("30 2 * * *", "America/New_York", from);
  assert.equal(iso(next), "2026-03-09T06:30:00.000Z"); // 02:30 EDT on the 9th
});

test("a time inside the autumn overlap fires once, not twice", () => {
  // 2026-11-01: 01:30 happens twice in New York. The earlier instant wins, and
  // the run after that is the following day — not the second 01:30.
  const from = new Date("2026-10-31T12:00:00.000Z");
  const first = computeNextRun("30 1 * * *", "America/New_York", from);
  assert.equal(iso(first), "2026-11-01T05:30:00.000Z"); // 01:30 EDT
  const second = computeNextRun("30 1 * * *", "America/New_York", first!);
  assert.equal(iso(second), "2026-11-02T06:30:00.000Z"); // 01:30 EST, next day
});

test("a zone with a half-hour offset lands on the right instant", () => {
  // Asia/Kolkata is UTC+05:30 — the arithmetic has to survive a non-hour offset.
  const from = new Date("2026-09-10T00:00:00.000Z");
  assert.equal(
    iso(computeNextRun("15 9 * * *", "Asia/Kolkata", from)),
    "2026-09-10T03:45:00.000Z",
  );
});

test("midnight matches hour 0 (an ICU quirk renders it as 24)", () => {
  const from = new Date("2026-09-10T12:00:00.000Z");
  assert.equal(iso(computeNextRun("0 0 * * *", "UTC", from)), "2026-09-11T00:00:00.000Z");
});
