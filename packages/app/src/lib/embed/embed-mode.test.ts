import { describe, it, expect } from 'vitest'
import { parseEmbedMode, resolveEmbedMode } from '@/lib/embed/embed-mode'

describe('parseEmbedMode', () => {
  it('returns "chat" for ?embed=chat', () => {
    expect(parseEmbedMode('?embed=chat')).toBe('chat')
  })
  it('returns null when absent', () => {
    expect(parseEmbedMode('?foo=1')).toBeNull()
    expect(parseEmbedMode('')).toBeNull()
  })
  it('ignores unknown embed values', () => {
    expect(parseEmbedMode('?embed=bogus')).toBeNull()
  })
})

describe('resolveEmbedMode', () => {
  it('returns chat when env forces it even without query', () => {
    expect(resolveEmbedMode('', 'chat')).toBe('chat')
  })
  it('returns chat from query when env unset', () => {
    expect(resolveEmbedMode('?embed=chat', undefined)).toBe('chat')
  })
  it('returns null when neither', () => {
    expect(resolveEmbedMode('?x=1', undefined)).toBeNull()
    expect(resolveEmbedMode('', 'nope')).toBeNull()
  })
})
