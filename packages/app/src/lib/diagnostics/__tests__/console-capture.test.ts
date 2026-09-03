import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearConsoleCapture,
  getConsoleEntries,
  installConsoleCapture,
  redactSentryBreadcrumb,
  resetConsoleCaptureForTests,
} from '@/lib/diagnostics/console-capture'

describe('console-capture', () => {
  const originals = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  beforeEach(() => {
    resetConsoleCaptureForTests()
    clearConsoleCapture()
    console.debug = originals.debug
    console.info = originals.info
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
    installConsoleCapture()
  })

  afterEach(() => {
    console.debug = originals.debug
    console.info = originals.info
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
  })

  it('captures console output into the ring buffer', () => {
    console.log('hello', { ok: true })
    const entries = getConsoleEntries()
    expect(entries.length).toBe(1)
    expect(entries[0]?.level).toBe('log')
    expect(entries[0]?.message).toContain('hello')
  })

  it('still forwards to the original console methods', () => {
    const forwarded = vi.fn()
    console.warn = forwarded
    resetConsoleCaptureForTests()
    installConsoleCapture()
    console.warn('forward me')
    expect(forwarded).toHaveBeenCalledWith('forward me')
    expect(getConsoleEntries()).toHaveLength(1)
  })

  it('redacts bearer tokens in captured output', () => {
    console.info('auth Bearer secret-token-value')
    const entry = getConsoleEntries()[0]
    expect(entry?.message).toContain('Bearer [redacted]')
    expect(entry?.message).not.toContain('secret-token-value')
  })

  it('filters by level and search', () => {
    console.debug('debug line')
    console.error('error line')
    expect(getConsoleEntries({ level: 'error' })).toHaveLength(1)
    expect(getConsoleEntries({ search: 'debug' })).toHaveLength(1)
  })

  it('clears captured entries', () => {
    console.log('one')
    clearConsoleCapture()
    expect(getConsoleEntries()).toHaveLength(0)
  })
})

describe('redactSentryBreadcrumb (SEC-4)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'

  it('redacts the message and every console argument, including nested ones', () => {
    const out = redactSentryBreadcrumb({
      category: 'console',
      level: 'info',
      message: `auth Bearer ${jwt}`,
      data: {
        logger: 'console',
        arguments: ['token sk-abcdefghijklmnop', { headers: { authorization: `Bearer ${jwt}` } }, 42],
      },
    })
    expect(out.message).toBe('auth Bearer [redacted]')
    const args = out.data?.arguments as unknown[]
    expect(args[0]).toBe('token [redacted-key]')
    expect((args[1] as { headers: { authorization: string } }).headers.authorization).toBe('Bearer [redacted]')
    expect(args[2]).toBe(42)
  })

  it('redacts string values in non-console breadcrumbs too (fetch URLs)', () => {
    const out = redactSentryBreadcrumb({
      category: 'fetch',
      data: { url: `https://api.example.test/v1?access_token=${jwt}`, method: 'GET', status_code: 200 },
    })
    expect(out.data?.url).not.toContain(jwt)
    expect(out.data?.url).toContain('[redacted-jwt]')
    expect(out.data?.status_code).toBe(200)
  })

  it('does not mutate the breadcrumb it was given', () => {
    const input = { category: 'console', message: `Bearer ${jwt}`, data: { arguments: [`Bearer ${jwt}`] } }
    redactSentryBreadcrumb(input)
    expect(input.message).toBe(`Bearer ${jwt}`)
    expect(input.data.arguments[0]).toBe(`Bearer ${jwt}`)
  })
})
