import { describe, expect, it } from 'vitest'
import { formatAppCode } from '../app-code'

describe('formatAppCode', () => {
  it.each([
    ['k7m2q9vx4n8p', 'a-k7m2q9vx4n8p'],
    ['a-k7m2q9vx4n8p', 'a-k7m2q9vx4n8p'],
    ['ak7m2q9vx4n8', 'a-ak7m2q9vx4n8'],
    ['a-ak7m2q9vx4n8', 'a-ak7m2q9vx4n8'],
  ])('formats %s without changing the random part', (value, expected) => {
    expect(formatAppCode(value)).toBe(expected)
  })

  it.each([
    null, undefined, 123, {}, ['k7m2q9vx4n8p'], '',
    'a-a-k7m2q9vx4n8p', 'K7M2Q9VX4N8P', 'a-K7M2Q9VX4N8P',
    'A-k7m2q9vx4n8p', ' k7m2q9vx4n8p', 'a-k7m2q9vx4n8p ',
    'a-k7m2q9vx4n8p\n', 'k7m2q9vx4n8p\n', 'short',
    'k7m2q9vx4n8p0', 'a-k7m2q9vx4n8p0',
    'k7m2q9vx4n8i', 'k7m2q9vx4n8l', 'k7m2q9vx4n8o', 'k7m2q9vx4n8u',
    'a-k7m2q9vx4n8i', 'a-k7m2q9vx4n8l', 'a-k7m2q9vx4n8o', 'a-k7m2q9vx4n8u',
  ])('rejects malformed or missing code %j without repairing it', (value) => {
    expect(formatAppCode(value)).toBeNull()
  })
})
