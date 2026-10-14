import { describe, expect, it } from 'vitest'
import { describeIllegalChars, invalidFileName } from '@/lib/file-name'

describe('invalidFileName', () => {
  it('accepts ordinary names, including Chinese and dots inside', () => {
    expect(invalidFileName('会议纪要.md')).toBeNull()
    expect(invalidFileName('v1.2.final.txt')).toBeNull()
    expect(invalidFileName('.gitignore')).toBeNull()
    expect(invalidFileName('console.log')).toBeNull()
  })

  it('reports each character Windows refuses, once', () => {
    expect(invalidFileName('会议: 周一?.md')).toEqual({ kind: 'chars', chars: [':', '?'] })
    expect(invalidFileName('a::b')).toEqual({ kind: 'chars', chars: [':'] })
    expect(invalidFileName('a/b')).toEqual({ kind: 'chars', chars: ['/'] })
    expect(invalidFileName('a\\b')).toEqual({ kind: 'chars', chars: ['\\'] })
    expect(invalidFileName('a\tb')).toEqual({ kind: 'chars', chars: ['\t'] })
  })

  it('rejects DOS device names with or without an extension', () => {
    expect(invalidFileName('CON')).toEqual({ kind: 'reserved' })
    expect(invalidFileName('nul.txt')).toEqual({ kind: 'reserved' })
    expect(invalidFileName('com1.md')).toEqual({ kind: 'reserved' })
    expect(invalidFileName('lpt9')).toEqual({ kind: 'reserved' })
    expect(invalidFileName('cons')).toBeNull()
    expect(invalidFileName('com10')).toBeNull()
  })

  it('rejects a trailing space or period', () => {
    expect(invalidFileName('notes.')).toEqual({ kind: 'trailing' })
    expect(invalidFileName('notes ')).toEqual({ kind: 'trailing' })
  })
})

describe('describeIllegalChars', () => {
  it('shows control characters by code point', () => {
    expect(describeIllegalChars([':', '\t'])).toBe(': U+0009')
  })
})
