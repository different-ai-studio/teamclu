import { describe, expect, test } from 'vitest'
import {
  isSkillsMarketplaceDetail,
  pickDefaultSubjectActor,
  skillsDetailOccupiesPane,
} from '@/lib/skills/default-subject-actor'

const agents = [{ id: 'local' }, { id: 'remote' }]

describe('pickDefaultSubjectActor', () => {
  test('entering Skills selects the current agent over the previous pick', () => {
    expect(
      pickDefaultSubjectActor({
        agents,
        selectedId: 'remote',
        preferredIds: ['local'],
        preferCurrent: true,
      }),
    ).toBe('local')
  })

  test('keeps a valid pick when this is not a fresh Skills entry', () => {
    expect(
      pickDefaultSubjectActor({
        agents,
        selectedId: 'remote',
        preferredIds: ['local'],
        preferCurrent: false,
      }),
    ).toBe('remote')
  })

  test('fills an empty selection from the current agent', () => {
    expect(
      pickDefaultSubjectActor({
        agents,
        selectedId: null,
        preferredIds: [null, 'remote'],
        preferCurrent: false,
      }),
    ).toBe('remote')
  })

  test('skips a current agent the user cannot manage', () => {
    expect(
      pickDefaultSubjectActor({
        agents,
        selectedId: 'remote',
        preferredIds: ['someone-else', 'local'],
        preferCurrent: true,
      }),
    ).toBe('local')
  })

  test('falls back to the only manageable agent', () => {
    expect(
      pickDefaultSubjectActor({
        agents: [{ id: 'only' }],
        selectedId: null,
        preferredIds: [],
        preferCurrent: true,
      }),
    ).toBe('only')
  })

  test('clears a stale selection when several agents remain and none is current', () => {
    expect(
      pickDefaultSubjectActor({
        agents,
        selectedId: 'gone',
        preferredIds: ['also-gone'],
        preferCurrent: true,
      }),
    ).toBeNull()
  })
})

describe('skills marketplace pane', () => {
  test('marketplace views count as occupying the Skills column', () => {
    expect(isSkillsMarketplaceDetail({ kind: 'marketplace' })).toBe(true)
    expect(isSkillsMarketplaceDetail({ kind: 'marketplace-item' })).toBe(true)
    expect(skillsDetailOccupiesPane({ kind: 'skill' })).toBe(true)
    expect(skillsDetailOccupiesPane(null)).toBe(false)
    expect(skillsDetailOccupiesPane({ kind: 'mcp' })).toBe(false)
  })
})
