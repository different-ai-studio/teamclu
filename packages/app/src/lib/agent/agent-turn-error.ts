import type { TFunction } from 'i18next'

/** User-initiated turn cancel (opencode abort) — not a fault. */
export const TURN_INTERRUPTED_ERROR_NAME = 'TurnInterrupted'

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
  return false
}

/** Classify daemon-emitted AcpError.message into a UI error name. */
export function classifyAgentTurnErrorName(message: string | undefined): string {
  const raw = (message ?? '').trim()
  const lower = raw.toLowerCase()
  if (isAgentTurnAbortError(raw)) {
    return TURN_INTERRUPTED_ERROR_NAME
  }
  if (lower === 'model stalled' || lower === 'model provider not responding') {
    return 'AgentTimeoutError'
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
