import { describe, it, expect } from 'vitest'
import { buildBadgeMap, badgeForDirectory } from '../team-sync-badges'

const none = { conflicts: {}, local: {}, remote: {} }

describe('buildBadgeMap', () => {
  it('says nothing when there is nothing to say', () => {
    expect(buildBadgeMap(none)).toEqual({})
  })

  it('reports each side on its own', () => {
    const badges = buildBadgeMap({
      ...none,
      local: { 'knowledge/a.md': 'new', 'knowledge/b.md': 'modified' },
      remote: { 'knowledge/c.md': {} },
    })
    expect(badges).toEqual({
      'knowledge/a.md': 'local-new',
      'knowledge/b.md': 'local-modified',
      'knowledge/c.md': 'remote-ahead',
    })
  })

  it('warns before the damage when both sides moved', () => {
    // This is the only state that can be acted on BEFORE a conflict exists.
    const badges = buildBadgeMap({
      ...none,
      local: { 'knowledge/a.md': 'modified' },
      remote: { 'knowledge/a.md': {} },
    })
    expect(badges['knowledge/a.md']).toBe('both')
  })

  it('lets an existing conflict outrank everything', () => {
    const badges = buildBadgeMap({
      conflicts: { 'knowledge/a.md': [{}] },
      local: { 'knowledge/a.md': 'modified' },
      remote: { 'knowledge/a.md': {} },
    })
    expect(badges['knowledge/a.md']).toBe('conflict')
  })

  it('keeps a deletion in the map so its folder can inherit it', () => {
    // The file's own row is gone from the tree, but the folder's is not — and
    // without this the panel counted a pending push that nothing in the tree
    // accounted for.
    const badges = buildBadgeMap({ ...none, local: { 'knowledge/team/gone.md': 'deleted' } })
    expect(badges['knowledge/team/gone.md']).toBe('local-modified')
    expect(badgeForDirectory('knowledge/team', badges)).toBe('local-modified')
  })
})

describe('badgeForDirectory', () => {
  const badges = {
    'knowledge/team/a.md': 'local-new' as const,
    'knowledge/team/deep/b.md': 'conflict' as const,
    'knowledge/other/c.md': 'remote-ahead' as const,
  }

  it('inherits the loudest thing inside it', () => {
    // A folder with one conflict and one tidy edit reads as "conflict in here".
    expect(badgeForDirectory('knowledge/team', badges)).toBe('conflict')
  })

  it('does not reach into a sibling folder', () => {
    expect(badgeForDirectory('knowledge/other', badges)).toBe('remote-ahead')
  })

  it('is null for a folder with nothing pending', () => {
    expect(badgeForDirectory('knowledge/empty', badges)).toBeNull()
  })

  it('does not treat a name prefix as a parent', () => {
    // `knowledge/te` is not the parent of `knowledge/team/a.md`.
    expect(badgeForDirectory('knowledge/te', badges)).toBeNull()
  })
})
