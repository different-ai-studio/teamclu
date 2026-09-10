import { ApiError } from "./http-utils.js";

/**
 * Five-field cron expressions, evaluated against an IANA time zone.
 *
 * Hand-written rather than a dependency because `services/fc` is packaged for
 * two deploy targets (the self-host container and Alibaba FC) and every extra
 * package is one more thing that can be present on one and missing on the
 * other — a class of failure this repo has already paid for. The logic is a
 * hundred lines of pure functions with no I/O, which is the cheap half of a
 * cron library; the expensive half (job storage, locking, retries) lives in the
 * database and the runner.
 *
 * Fields, in order: minute hour day-of-month month day-of-week.
 * Supported syntax per field: `*`, `a`, `a,b`, `a-b`, `*​/n`, `a-b/n`, and
 * three-letter names for month and day-of-week. Sunday is both 0 and 7.
 *
 * NOT supported, deliberately: `@daily` and friends (one more spelling of
 * something the five fields already say), `L`/`W`/`#` (they exist to express
 * "last Friday of the month", which no scheduled HTTP call has ever needed),
 * and seconds (a sub-minute schedule against a deployed function is a load
 * test, not a cron job).
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Vixie semantics: with BOTH day fields restricted, either one matching is
   *  enough. Recorded at parse time so the matcher does not re-derive it. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const SPECS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  // 7 is accepted and folded onto 0 — both spellings of Sunday are in the wild.
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES },
];

function bad(message: string): never {
  throw new ApiError(400, "validation_failed", message);
}

function parseValue(raw: string, spec: FieldSpec): number {
  const token = raw.trim().toLowerCase();
  if (spec.names && token in spec.names) return spec.names[token];
  if (!/^\d+$/.test(token)) {
    bad(`cron ${spec.name} field: "${raw}" is not a number`);
  }
  const n = Number.parseInt(token, 10);
  if (n < spec.min || n > spec.max) {
    bad(`cron ${spec.name} field: ${n} is outside ${spec.min}-${spec.max}`);
  }
  return n;
}

/** One field into the set of values it admits, plus whether it constrains. */
function parseField(raw: string, spec: FieldSpec): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) bad(`cron ${spec.name} field: empty item in "${raw}"`);

    const [rangePart, stepPart, ...rest] = piece.split("/");
    if (rest.length > 0) bad(`cron ${spec.name} field: "${piece}" has more than one step`);

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number.parseInt(stepPart, 10) < 1) {
        bad(`cron ${spec.name} field: step "${stepPart}" must be a positive number`);
      }
      step = Number.parseInt(stepPart, 10);
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
      // `*` alone leaves the field unrestricted; `*​/2` does constrain it, and
      // that distinction is what the two day fields' either-or rule turns on.
      if (stepPart !== undefined) restricted = true;
    } else if (rangePart.includes("-")) {
      const [a, b, ...extra] = rangePart.split("-");
      if (extra.length > 0) bad(`cron ${spec.name} field: "${rangePart}" is not a range`);
      lo = parseValue(a, spec);
      hi = parseValue(b, spec);
      if (lo > hi) bad(`cron ${spec.name} field: range ${rangePart} runs backwards`);
      restricted = true;
    } else {
      lo = parseValue(rangePart, spec);
      hi = lo;
      restricted = true;
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  if (values.size === 0) bad(`cron ${spec.name} field: "${raw}" matches nothing`);
  return { values, restricted };
}

export function parseCronExpression(expr: string): CronFields {
  if (typeof expr !== "string") bad("cron expression must be a string");
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    bad(
      `cron expression needs 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }

  const minute = parseField(fields[0], SPECS[0]);
  const hour = parseField(fields[1], SPECS[1]);
  const dayOfMonth = parseField(fields[2], SPECS[2]);
  const month = parseField(fields[3], SPECS[3]);
  const dayOfWeek = parseField(fields[4], SPECS[4]);

  // Fold 7 onto 0 so the matcher compares against one spelling of Sunday.
  const dow = new Set<number>();
  for (const d of dayOfWeek.values) dow.add(d === 7 ? 0 : d);

  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dow,
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}

/** Throws unless the zone is one this runtime's ICU knows. */
export function assertTimeZone(tz: string): void {
  if (typeof tz !== "string" || !tz.trim()) bad("timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    bad(`unknown timezone: ${tz}`);
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      // h23, not hour12:false: the latter renders midnight as "24" on some ICU
      // builds, which silently never matches an `hour` field.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

/** What the wall clock in `tz` reads at this instant. */
export function wallClockAt(instant: Date, tz: string): WallClock {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number.parseInt(get("year"), 10),
    month: Number.parseInt(get("month"), 10),
    day: Number.parseInt(get("day"), 10),
    hour: Number.parseInt(get("hour"), 10),
    minute: Number.parseInt(get("minute"), 10),
    weekday: DAY_NAMES[get("weekday").toLowerCase().slice(0, 3)] ?? 0,
  };
}

/**
 * The instant at which `tz`'s wall clock reads exactly this date and time, or
 * null when no such instant exists.
 *
 * Null is not a failure: it is the spring-forward gap. A job scheduled for
 * 02:30 in a zone that jumps 02:00 → 03:00 simply does not run that day, which
 * is both what every other cron does and the only answer that does not invent
 * a time the user did not ask for.
 *
 * An AMBIGUOUS wall time (the autumn overlap, where 02:30 happens twice)
 * resolves to one instant — the job runs once, not twice.
 */
function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date | null {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Offsets are found by asking what the zone reads at a guess and correcting
  // by the difference. Two rounds converge everywhere: the first lands within
  // an hour of the answer, the second within the zone's actual offset there.
  let instant = target;
  for (let i = 0; i < 2; i += 1) {
    const w = wallClockAt(new Date(instant), tz);
    const readsAs = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0);
    const drift = readsAs - target;
    if (drift === 0) return new Date(instant);
    instant -= drift;
  }

  // Round-trip check. Everything that survives this reads back as exactly the
  // requested wall time; everything that does not is a gap.
  const w = wallClockAt(new Date(instant), tz);
  if (
    w.year === year && w.month === month && w.day === day &&
    w.hour === hour && w.minute === minute
  ) {
    return new Date(instant);
  }
  return null;
}

function dayMatches(fields: CronFields, w: WallClock): boolean {
  if (!fields.month.has(w.month)) return false;
  const dom = fields.dayOfMonth.has(w.day);
  const dow = fields.dayOfWeek.has(w.weekday);
  // Vixie's rule: restrict both day fields and the job runs on the union, not
  // the intersection. `0 0 1 * MON` is "the 1st, and every Monday".
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return dom || dow;
  if (fields.dayOfMonthRestricted) return dom;
  if (fields.dayOfWeekRestricted) return dow;
  return true;
}

/** Four years of candidate days: enough to reach Feb 29 from any starting point. */
const MAX_DAYS_AHEAD = 366 * 4;

/**
 * The first instant strictly after `from` that satisfies the expression.
 *
 * Null means no such instant within four years, which in practice means the
 * expression names a date that does not exist (`0 0 30 2 *`). Stored as a NULL
 * `next_run_at`, where it reads as "never again" — the job stays visible and
 * editable instead of being rejected at save time for a reason that is hard to
 * see in five numbers.
 *
 * Search is per-day, not per-minute: days that cannot match are skipped whole,
 * so the worst case is ~1500 calendar checks rather than two million minute
 * checks.
 */
export function nextRunAfter(
  fields: CronFields,
  tz: string,
  from: Date,
): Date | null {
  const hours = [...fields.hour].sort((a, b) => a - b);
  const minutes = [...fields.minute].sort((a, b) => a - b);
  const start = wallClockAt(from, tz);

  for (let offset = 0; offset < MAX_DAYS_AHEAD; offset += 1) {
    // Calendar arithmetic on the LOCAL date. Date.UTC normalises overflow
    // (Jan 32 → Feb 1) and is only used as a calendar here, never as an
    // instant, so the zone's offset is irrelevant to this step.
    const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const w: WallClock = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
      hour: 0,
      minute: 0,
      weekday: cursor.getUTCDay(),
    };
    if (!dayMatches(fields, w)) continue;

    for (const hour of hours) {
      // On the starting day, everything before `from`'s own wall clock is known
      // to be in the past. Skipping it matters for `* * * * *`, where checking
      // it would mean ~1400 pointless zone conversions on every single tick.
      if (offset === 0 && hour < start.hour) continue;
      for (const minute of minutes) {
        if (offset === 0 && hour === start.hour && minute <= start.minute) continue;
        const instant = wallClockToInstant(w.year, w.month, w.day, hour, minute, tz);
        if (!instant) continue; // DST gap — no such local time on this day.
        if (instant.getTime() > from.getTime()) return instant;
      }
    }
  }
  return null;
}

/** Parse, validate the zone, and compute the next fire in one call. */
export function computeNextRun(
  expr: string,
  tz: string,
  from: Date = new Date(),
): Date | null {
  assertTimeZone(tz);
  return nextRunAfter(parseCronExpression(expr), tz, from);
}
