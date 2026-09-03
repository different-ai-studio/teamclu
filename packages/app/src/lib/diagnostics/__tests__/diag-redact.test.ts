import { describe, expect, it } from 'vitest'
import { describeJwt, redactLogString, redactObject } from '@/lib/diagnostics/diag-redact'

describe('diag-redact', () => {
  it('redacts bearer tokens and api keys from log strings', () => {
    const out = redactLogString('Bearer abc.def.ghi sk-1234567890123456')
    expect(out).toContain('Bearer [redacted]')
    expect(out).toContain('[redacted-key]')
    expect(out).not.toContain('abc.def.ghi')
  })

  it('redacts sensitive object keys', () => {
    const out = redactObject({
      password: 'secret',
      label: 'visible',
    })
    expect(out.password).toBe('[redacted]')
    expect(out.label).toBe('visible')
  })

  it('describes jwt metadata without returning the raw token', () => {
    const header = btoa(JSON.stringify({ alg: 'none' }))
    const payload = btoa(JSON.stringify({ sub: 'user-1', exp: 4102444800 }))
    const token = `${header}.${payload}.sig`
    const described = describeJwt(token)
    expect(described).toMatchObject({ kind: 'jwt', sub: 'user-1' })
  })
})
