/**
 * TeamClu protobuf message timestamps are canonically Unix seconds.  A few
 * older live publishers sent Unix milliseconds instead, which otherwise puts
 * a message tens of thousands of years into the future after UI conversion.
 */
const MAX_UNIX_SECONDS = 10_000_000_000;

export function normalizeUnixTimestampSeconds(
  value: bigint | number | string | null | undefined,
): bigint {
  let numeric: number;
  if (typeof value === "bigint") {
    numeric = Number(value);
  } else if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    numeric = Number(value);
  } else {
    return 0n;
  }

  if (!Number.isFinite(numeric) || numeric <= 0) return 0n;
  // Accept milliseconds, microseconds, and nanoseconds defensively. A
  // seconds value remains unchanged; repeatedly dividing makes this safe for
  // legacy publishers that used a finer unit.
  while (numeric > MAX_UNIX_SECONDS) numeric /= 1000;
  return BigInt(Math.floor(numeric));
}

export function unixTimestampSecondsToIso(
  value: bigint | number | string | null | undefined,
  fallback = new Date().toISOString(),
): string {
  const seconds = normalizeUnixTimestampSeconds(value);
  if (seconds <= 0n) return fallback;
  return new Date(Number(seconds) * 1000).toISOString();
}
