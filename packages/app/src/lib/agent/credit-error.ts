/**
 * Recognise the AI gateway's "out of credits" refusals inside a provider error.
 *
 * The team gateway answers 402 with one of two codes
 * (`services/ai-gateway/src/credits.ts`):
 *
 * - `insufficient_credits` — the team wallet is empty. Everyone is stopped and
 *   only a top-up fixes it; retrying or switching models does nothing, since
 *   every model draws on the same wallet.
 * - `quota_exceeded` — one member used up their own limit for the period. The
 *   fix is raising that limit.
 *
 * pi forwards the gateway body as the turn error's detail
 * (`402: {"code":"insufficient_credits",…}`), and the daemon stamps the same
 * code on the failed AGENT_REPLY as `metadata.failure_reason`. The daemon twin
 * is `apps/daemon/src/runtime/credit_error.rs`; keep the two in step.
 */

export type CreditErrorReason = 'insufficient_credits' | 'quota_exceeded'

/** `SessionErrorEvent.error.name` for each reason. */
export const INSUFFICIENT_CREDITS_ERROR_NAME = 'InsufficientCreditsError'
export const QUOTA_EXCEEDED_ERROR_NAME = 'QuotaExceededError'

function containsToken(haystack: string, needle: string): boolean {
  // Whole-token match, so `app_storage_quota_exceeded` is not a member quota.
  return new RegExp(`(^|[^A-Za-z0-9_])${needle}($|[^A-Za-z0-9_])`).test(haystack)
}

/** The gateway credit refusal named anywhere in `texts`, if any. */
export function detectCreditErrorReason(
  ...texts: Array<string | null | undefined>
): CreditErrorReason | null {
  const blob = texts.filter(Boolean).join('\n')
  if (!blob) return null
  if (containsToken(blob, 'insufficient_credits')) return 'insufficient_credits'
  if (containsToken(blob, 'quota_exceeded')) return 'quota_exceeded'
  return null
}

/** Parse `metadata.failure_reason` from a failed AGENT_REPLY. */
export function parseCreditErrorReason(value: unknown): CreditErrorReason | null {
  return value === 'insufficient_credits' || value === 'quota_exceeded' ? value : null
}

export function creditErrorNameForReason(reason: CreditErrorReason): string {
  return reason === 'insufficient_credits'
    ? INSUFFICIENT_CREDITS_ERROR_NAME
    : QUOTA_EXCEEDED_ERROR_NAME
}

export function creditErrorReasonForName(name: string | undefined): CreditErrorReason | null {
  if (name === INSUFFICIENT_CREDITS_ERROR_NAME) return 'insufficient_credits'
  if (name === QUOTA_EXCEEDED_ERROR_NAME) return 'quota_exceeded'
  return null
}
