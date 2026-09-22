import { describe, expect, it } from 'vitest'
import { isLlmWikiSyncKey } from '../wiki-vault'

describe('isLlmWikiSyncKey', () => {
  it('matches the wiki folder and its pages', () => {
    expect(isLlmWikiSyncKey('knowledge/wiki')).toBe(true)
    expect(isLlmWikiSyncKey('knowledge/wiki/index.md')).toBe(true)
    expect(isLlmWikiSyncKey('knowledge/wiki/pages/请假.md')).toBe(true)
    expect(isLlmWikiSyncKey('wiki/index.md')).toBe(true)
  })

  it('does not match human-reviewed knowledge', () => {
    expect(isLlmWikiSyncKey('knowledge/30-decisions/adr.md')).toBe(false)
    expect(isLlmWikiSyncKey('knowledge/00-home.md')).toBe(false)
    expect(isLlmWikiSyncKey('documents/handbook/leave.md')).toBe(false)
    expect(isLlmWikiSyncKey('documents/wiki/notes.md')).toBe(false)
    expect(isLlmWikiSyncKey(null)).toBe(false)
  })
})
