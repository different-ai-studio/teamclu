import { describe, it, expect } from 'vitest'
import { sectionModeFor } from '../section-mode'

describe('sectionModeFor', () => {
  it('makes the apps list a section, with the library as its main view', () => {
    expect(sectionModeFor({ kind: 'apps' })).toBe('apps')
    expect(sectionModeFor({ kind: 'apps' }, true)).toBe('apps')
  })

  it('gives the conversation back once an app is drilled into', () => {
    expect(sectionModeFor({ kind: 'apps' }, false)).toBeNull()
  })

  it('leaves the other sections as they were', () => {
    expect(sectionModeFor({ kind: 'teamShare', section: 'skills' })).toBe('skills')
    expect(sectionModeFor({ kind: 'actors' })).toBe('actors')
    expect(sectionModeFor({ kind: 'all' })).toBeNull()
  })
})
