/**
 * Billing period boundaries, anchored to Asia/Shanghai (fixed UTC+8, no DST).
 *
 * The usage report and the quota check MUST agree on where a period starts, or
 * a member sees "used 900 of 1000" on the billing screen while the gateway
 * refuses their next request. One implementation, used by both.
 */
export type Period = "week" | "month";

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Start of the current period, as a UTC instant. */
export function periodStart(period: Period, now: Date = new Date()): Date {
  // Shift into CST wall-clock, truncate there, shift back.
  const cst = new Date(now.getTime() + CST_OFFSET_MS);
  const y = cst.getUTCFullYear();
  const m = cst.getUTCMonth();
  const d = cst.getUTCDate();

  let startCst: number;
  if (period === "month") {
    startCst = Date.UTC(y, m, 1);
  } else {
    // Week starts Monday. getUTCDay() is 0=Sunday, so Sunday is 6 days in.
    const dow = cst.getUTCDay();
    const daysSinceMonday = (dow + 6) % 7;
    startCst = Date.UTC(y, m, d - daysSinceMonday);
  }
  return new Date(startCst - CST_OFFSET_MS);
}
