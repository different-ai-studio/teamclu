import { describe, expect, it } from 'vitest'
import {
  agentTurnErrorDisplay,
  classifyAgentTurnErrorName,
  formatAgentTurnErrorDisplayMessage,
  isAgentTurnAbortError,
  isStalePiExtensionCtxError,
  isPersistentSessionTurnError,
  isQuotaLikeAgentMessage,
  localizeAgentTurnErrorMessage,
} from '@/lib/agent/agent-turn-error'

const t = ((key: string, fallback?: string) => fallback ?? key) as never

describe('isAgentTurnAbortError', () => {
  it('detects MessageAbortedError', () => {
    expect(isAgentTurnAbortError('MessageAbortedError', 'Aborted')).toBe(true)
  })

  it('detects formatted display string', () => {
    expect(isAgentTurnAbortError('MessageAbortedError: Aborted')).toBe(true)
  })

  it('does not treat bare Aborted detail as interrupt', () => {
    expect(isAgentTurnAbortError('AgentError', 'Aborted')).toBe(false)
    expect(isAgentTurnAbortError(undefined, 'Aborted')).toBe(false)
  })

  it('treats abort-shaped provider error details as interrupt', () => {
    expect(
      isAgentTurnAbortError('model provider error', 'This operation was aborted'),
    ).toBe(true)
  })

  it('does not match unrelated failures', () => {
    expect(isAgentTurnAbortError('model stalled', 'No output')).toBe(false)
  })
})

describe('isStalePiExtensionCtxError', () => {
  it('matches the pi stale-context banner', () => {
    expect(
      isStalePiExtensionCtxError(
        'pi extension error',
        'This extension ctx is stale after session replacement or reload.',
      ),
    ).toBe(true)
  })

  it('leaves a real extension failure visible', () => {
    expect(isStalePiExtensionCtxError('pi extension error', 'boom in extension')).toBe(false)
  })
})

describe('classifyAgentTurnErrorName', () => {
  it('maps abort to TurnInterrupted', () => {
    expect(classifyAgentTurnErrorName('MessageAbortedError')).toBe('TurnInterrupted')
  })

  it('maps abort-shaped provider error to TurnInterrupted', () => {
    expect(
      classifyAgentTurnErrorName('model provider error', 'This operation was aborted'),
    ).toBe('TurnInterrupted')
  })

  it('maps model stalled to AgentTimeoutError', () => {
    expect(classifyAgentTurnErrorName('model stalled')).toBe('AgentTimeoutError')
  })

  it('maps model provider error to ProviderError', () => {
    expect(classifyAgentTurnErrorName('model provider error')).toBe('ProviderError')
  })

  it('maps quota-like messages to RetryError', () => {
    expect(classifyAgentTurnErrorName('monthly usage limit reached')).toBe('RetryError')
  })

  it('does not classify generic agent errors as quota', () => {
    expect(classifyAgentTurnErrorName('opencode prompt failed')).toBe('AgentError')
  })
})

describe('localizeAgentTurnErrorMessage', () => {
  it('localizes model stalled', () => {
    expect(localizeAgentTurnErrorMessage('model stalled', t)).toContain('stopped responding')
  })
})

describe('formatAgentTurnErrorDisplayMessage', () => {
  it('combines localized title and detail', () => {
    expect(
      formatAgentTurnErrorDisplayMessage('Model stalled', 'No output for 120s'),
    ).toBe('Model stalled: No output for 120s')
  })

  it('avoids duplicating identical detail', () => {
    expect(formatAgentTurnErrorDisplayMessage('Same', 'Same')).toBe('Same')
  })
})

describe('isPersistentSessionTurnError', () => {
  it('treats timeout and provider errors as persistent', () => {
    expect(isPersistentSessionTurnError('AgentTimeoutError')).toBe(true)
    expect(isPersistentSessionTurnError('ProviderError')).toBe(true)
    expect(isPersistentSessionTurnError('RetryError')).toBe(true)
    expect(isPersistentSessionTurnError('AgentError')).toBe(false)
  })
})

describe('isQuotaLikeAgentMessage', () => {
  it('does not match model stalled detail text', () => {
    expect(
      isQuotaLikeAgentMessage(
        'No output from the model for 120s — the provider may be unreachable or overloaded.',
      ),
    ).toBe(false)
  })
})

describe('gateway credit refusals', () => {
  const emptyWallet =
    '402: {"code":"insufficient_credits","message":"the team\'s credit balance is exhausted"}'
  const memberQuota = '402: {"code":"quota_exceeded","message":"member quota reached"}'

  it('classifies them apart from a generic provider error', () => {
    expect(classifyAgentTurnErrorName('model provider error', emptyWallet)).toBe(
      'InsufficientCreditsError',
    )
    expect(classifyAgentTurnErrorName('model provider error', memberQuota)).toBe(
      'QuotaExceededError',
    )
    expect(classifyAgentTurnErrorName('model provider error', '500 upstream boom')).toBe(
      'ProviderError',
    )
  })

  it('keeps them on screen until dismissed', () => {
    expect(isPersistentSessionTurnError('InsufficientCreditsError')).toBe(true)
    expect(isPersistentSessionTurnError('QuotaExceededError')).toBe(true)
  })

  it('replaces the raw 402 JSON with a sentence and drops the detail', () => {
    const shown = agentTurnErrorDisplay('model provider error', emptyWallet, t)
    expect(shown.detail).toBe('')
    expect(shown.message).not.toContain('insufficient_credits')
    expect(shown.message).not.toMatch(/retry or switch/i)
    expect(shown.message).toContain('balance')
  })

  it('leaves other provider errors as they were', () => {
    const shown = agentTurnErrorDisplay('model provider error', '500 upstream boom', t)
    expect(shown.detail).toBe('500 upstream boom')
    expect(shown.message).toContain('retry or switch models')
  })
})
