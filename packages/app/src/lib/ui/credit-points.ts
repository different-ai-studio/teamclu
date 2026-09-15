/**
 * UI「积分」vs API/DB credits.
 *
 * Storage and the gateway charge in atomic credits. The settings UI shows
 * points so wallet balances stay in a readable range. Change this divisor to
 * rescale display only — never the underlying charge.
 *
 * Historical: was 10_000; scaled to 100_000 so typical monthly usage reads in
 * thousands rather than tens of thousands.
 */
export const CREDITS_PER_POINT = 100_000

export function creditsToPoints(credits: number): number {
  return credits / CREDITS_PER_POINT
}

export function formatPoints(credits: number): string {
  return creditsToPoints(credits).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
