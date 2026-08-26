import { describe, expect, it } from 'vitest'

import { isIgnoredSyncKey } from '../knowledge-ignored'

const roots = new Set(['knowledge/node_modules', 'knowledge/proj/target', 'knowledge/.DS_Store'])

describe('isIgnoredSyncKey', () => {
  it('matches the ignored root itself', () => {
    expect(isIgnoredSyncKey('knowledge/node_modules', roots)).toBe(true)
    expect(isIgnoredSyncKey('knowledge/.DS_Store', roots)).toBe(true)
  })

  // The reason this function exists: the daemon reports one entry per ignored
  // root, so everything beneath it has to be recognised here.
  it('matches anything beneath an ignored root', () => {
    expect(isIgnoredSyncKey('knowledge/node_modules/left-pad/index.js', roots)).toBe(true)
    expect(isIgnoredSyncKey('knowledge/proj/target/debug/build/x.rlib', roots)).toBe(true)
  })

  it('leaves ordinary documents alone', () => {
    expect(isIgnoredSyncKey('knowledge/notes/a.md', roots)).toBe(false)
    expect(isIgnoredSyncKey('knowledge/proj/README.md', roots)).toBe(false)
  })

  // A sibling whose name merely starts with an ignored root's name is not
  // beneath it — matching on raw string prefix would get this wrong.
  it('does not match a sibling with a shared name prefix', () => {
    expect(isIgnoredSyncKey('knowledge/node_modules_backup/a.md', roots)).toBe(false)
    expect(isIgnoredSyncKey('knowledge/proj/target-notes.md', roots)).toBe(false)
  })

  it('is false when nothing is ignored', () => {
    expect(isIgnoredSyncKey('knowledge/node_modules/a.js', new Set())).toBe(false)
  })
})
