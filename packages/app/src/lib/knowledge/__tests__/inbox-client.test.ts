import { describe, expect, it } from 'vitest'
import { isAlreadyExistsError } from '@/lib/knowledge/inbox-client'

describe('isAlreadyExistsError', () => {
  it('recognizes the daemon conflict wording', () => {
    expect(isAlreadyExistsError(new Error("'x.md' already exists; refusing to overwrite"))).toBe(
      true,
    )
    expect(isAlreadyExistsError(new Error('already_exists'))).toBe(true)
    expect(isAlreadyExistsError(new Error('daemon is not connected'))).toBe(false)
  })
})
