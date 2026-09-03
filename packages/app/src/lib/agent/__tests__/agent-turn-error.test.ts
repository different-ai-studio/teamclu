import { describe, expect, it } from 'vitest'
import {
  classifyAgentTurnErrorName,
  formatAgentTurnErrorDisplayMessage,
  isAgentTurnAbortError,
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

  it('does not match unrelated failures', () => {
    expect(isAgentTurnAbortError('model stalled', 'No output')).toBe(false)
  })
})

describe('classifyAgentTurnErrorName', () => {
  it('maps abort to TurnInterrupted', () => {
    expect(classifyAgentTurnErrorName('MessageAbortedError')).toBe('TurnInterrupted')
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
