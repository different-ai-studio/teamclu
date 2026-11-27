import type { TFunction } from 'i18next'
import {
  creditErrorNameForReason,
  detectCreditErrorReason,
  INSUFFICIENT_CREDITS_ERROR_NAME,
  QUOTA_EXCEEDED_ERROR_NAME,
  type CreditErrorReason,
} from '@/lib/agent/credit-error'

/** User-initiated turn cancel (opencode abort) — not a fault. */
export const TURN_INTERRUPTED_ERROR_NAME = 'TurnInterrupted'

/**
 * pi `extension_error` whose text is the stale-context guard.
 *
 * Closing one session in a shared pi host used to invalidate the runtime
 * every other session still holds. The daemon keeps that turn running;
 * the desktop must not paint it as a service-notice banner.
 */
export function isStalePiExtensionCtxError(
  message: string | undefined,
  detail?: string | undefined,
): boolean {
  const blob = `${message ?? ''}\n${detail ?? ''}`.toLowerCase()
  return (
    blob.includes('stale after session replacement') ||
    blob.includes('extension ctx is stale')
  )
}

/** True when an ACP turn error is an intentional interrupt / abort. */
export function isAgentTurnAbortError(
  message: string | undefined,
  detail?: string | undefined,
): boolean {
  const name = (message ?? '').trim().toLowerCase()
  const det = (detail ?? '').trim().toLowerCase()
  if (!name && !det) return false
  if (name === TURN_INTERRUPTED_ERROR_NAME.toLowerCase()) return true
  // opencode / daemon: error.name = MessageAbortedError, data.message = Aborted
  if (name.includes('messageaborted')) return true
  // Display form already joined as "MessageAbortedError: Aborted"
  if (name.includes('messageabortederror')) return true
  if (name.includes('operation was aborted') || det.includes('operation was aborted')) {
    return true
  }
  if (det === 'request was aborted') return true
  if (name.includes('aborterror') || det.includes('aborterror')) return true
  return false
}

/** Classify daemon-emitted AcpError.message into a UI error name. */
export function classifyAgentTurnErrorName(
  message: string | undefined,
  detail?: string | undefined,
): string {
  const raw = (message ?? '').trim()
  const lower = raw.toLowerCase()
  if (isAgentTurnAbortError(raw, detail)) {
    return TURN_INTERRUPTED_ERROR_NAME
  }
  if (lower === 'model stalled' || lower === 'model provider not responding') {
    return 'AgentTimeoutError'
  }
  // Before the generic provider error: an empty wallet is not something a
  // retry or another model can fix, so it gets its own banner.
  const creditReason = detectCreditErrorReason(raw, detail)
  if (creditReason) {
    return creditErrorNameForReason(creditReason)
  }
  if (lower === 'model provider error') {
    return 'ProviderError'
  }
  if (
    lower.includes('quota') ||
    lower.includes('usage limit') ||
    lower.includes('free usage') ||
    lower.includes('out of credit')
  ) {
    return 'RetryError'
  }
  return 'AgentError'
}

/** User-facing sentence for a gateway credit refusal — replaces the raw 402 JSON. */
export function localizeCreditErrorMessage(reason: CreditErrorReason, t: TFunction): string {
  return reason === 'insufficient_credits'
    ? t(
        'errors.insufficientCreditsBody',
        "The team's AI balance is used up, so this turn was not run. It works again as soon as credits are added — no restart needed.",
      )
    : t(
        'errors.memberQuotaExceededBody',
        'Your personal AI quota for this period is used up, so this turn was not run. A team owner can raise your limit.',
      )
}

/**
 * Display text for a daemon turn error. Credit refusals come back as a plain
 * sentence with no raw detail; everything else keeps the provider's words.
 */
export function agentTurnErrorDisplay(
  message: string | undefined,
  detail: string | undefined,
  t: TFunction,
): { message: string; detail: string } {
  const creditReason = detectCreditErrorReason(message, detail)
  if (creditReason) {
    return { message: localizeCreditErrorMessage(creditReason, t), detail: '' }
  }
  return { message: localizeAgentTurnErrorMessage(message, t), detail: (detail ?? '').trim() }
}

/** Localize known daemon turn-error messages; pass through anything else. */
export function localizeAgentTurnErrorMessage(
  message: string | undefined,
  t: TFunction,
): string {
  const raw = (message ?? '').trim()
  const lower = raw.toLowerCase()
  if (lower === 'model stalled' || lower === 'model provider not responding') {
    return t(
      'daemon.agentRuntime.providerStalled',
      'The model provider stopped responding. It may be unavailable or rate-limited — please retry or switch models.',
    )
  }
  if (lower === 'model provider error') {
    return t(
      'daemon.agentRuntime.providerError',
      'The model provider reported an error. Please retry or switch models.',
    )
  }
  return raw || t('errors.error', 'Error')
}

export function formatAgentTurnErrorDisplayMessage(
  localizedMessage: string,
  detail: string,
): string {
  const trimmedDetail = detail.trim()
  if (!trimmedDetail || trimmedDetail === localizedMessage) {
    return localizedMessage
  }
  return `${localizedMessage}: ${trimmedDetail}`
}

/** Turn errors that should stay visible until the user dismisses or sends again. */
export function isPersistentSessionTurnError(errorName: string | undefined): boolean {
  switch (errorName) {
    case 'RetryError':
    case 'AgentTimeoutError':
    case 'ProviderError':
    case INSUFFICIENT_CREDITS_ERROR_NAME:
    case QUOTA_EXCEEDED_ERROR_NAME:
      return true
    default:
      return false
  }
}

/** True when message text alone indicates quota / usage-limit exhaustion. */
export function isQuotaLikeAgentMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('quota') ||
    lower.includes('usage limit') ||
    lower.includes('free usage') ||
    lower.includes('out of credit')
  )
}
