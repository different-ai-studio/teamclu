import { describe, expect, it } from 'vitest'
import { detectCreditErrorReason, parseCreditErrorReason } from '@/lib/agent/credit-error'

describe('detectCreditErrorReason', () => {
  it('reads the gateway code out of the body pi forwards', () => {
    expect(
      detectCreditErrorReason(
        'model provider error',
        '402: {"code":"insufficient_credits","message":"the team\'s credit balance is exhausted"}',
      ),
    ).toBe('insufficient_credits')
    expect(
      detectCreditErrorReason('402 {"error":{"code":"quota_exceeded","message":"x"}}'),
    ).toBe('quota_exceeded')
  })

  it('ignores other errors and look-alike codes', () => {
    expect(detectCreditErrorReason('400 You\'re out of extra usage.')).toBeNull()
    expect(detectCreditErrorReason('503 upstream_billing_error')).toBeNull()
    expect(detectCreditErrorReason('409 {"code":"app_storage_quota_exceeded"}')).toBeNull()
    expect(detectCreditErrorReason(undefined, '')).toBeNull()
  })
})

describe('parseCreditErrorReason', () => {
  it('accepts only the two known codes', () => {
    expect(parseCreditErrorReason('insufficient_credits')).toBe('insufficient_credits')
    expect(parseCreditErrorReason('quota_exceeded')).toBe('quota_exceeded')
    expect(parseCreditErrorReason('something_else')).toBeNull()
    expect(parseCreditErrorReason(undefined)).toBeNull()
  })
})
