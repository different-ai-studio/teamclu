import { describe, it, expect } from 'vitest'
import { buildFileMap, resolveWikiLink, getAllPageNames } from '@/lib/knowledge/wiki-link-index'

describe('buildFileMap', () => {
  it('builds map from file paths', () => {
    const paths = [
      'knowledge/Q2排期.md',
      'knowledge/project/roadmap.md',
      'knowledge/daily/2026-04-10.md',
    ]
    const map = buildFileMap(paths)
    expect(map.get('q2排期')).toBe('knowledge/Q2排期.md')
    expect(map.get('roadmap')).toBe('knowledge/project/roadmap.md')
    expect(map.get('2026-04-10')).toBe('knowledge/daily/2026-04-10.md')
  })

  it('keeps shortest path on name collision', () => {
    const paths = [
      'knowledge/deep/nested/排期.md',
      'knowledge/排期.md',
    ]
    const map = buildFileMap(paths)
    expect(map.get('排期')).toBe('knowledge/排期.md')
  })

  it('is case-insensitive on keys', () => {
    const paths = ['knowledge/README.md']
    const map = buildFileMap(paths)
    expect(map.get('readme')).toBe('knowledge/README.md')
  })

  it('ignores non-md files', () => {
    const paths = [
      'knowledge/notes.md',
      'knowledge/_assets/image.png',
    ]
    const map = buildFileMap(paths)
    expect(map.size).toBe(1)
    expect(map.has('image')).toBe(false)
  })
})

describe('resolveWikiLink', () => {
  const map = buildFileMap([
    'knowledge/Q2排期.md',
    'knowledge/project/roadmap.md',
  ])

  it('resolves exact match (case-insensitive)', () => {
    expect(resolveWikiLink(map, 'q2排期')).toBe('knowledge/Q2排期.md')
    expect(resolveWikiLink(map, 'Q2排期')).toBe('knowledge/Q2排期.md')
  })

  it('returns null for unresolved', () => {
    expect(resolveWikiLink(map, 'nonexistent')).toBeNull()
  })
})

describe('getAllPageNames', () => {
  it('returns display names from map values', () => {
    const map = buildFileMap([
      'knowledge/Q2排期.md',
      'knowledge/project/roadmap.md',
    ])
    const names = getAllPageNames(map)
    expect(names).toHaveLength(2)
    expect(names).toContainEqual({ name: 'Q2排期', dir: '' })
    expect(names).toContainEqual({ name: 'roadmap', dir: 'project/' })
  })
})
