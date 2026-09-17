import { describe, expect, test } from 'vitest'
import { teamSkillDeletableSlug } from '../registry-deletable'

describe('teamSkillDeletableSlug', () => {
  test('admin can delete a registry row', () => {
    expect(teamSkillDeletableSlug(true, 'registry', 'deploy-check')).toBe('deploy-check')
  })
  test('member never sees the control', () => {
    expect(teamSkillDeletableSlug(false, 'registry', 'deploy-check')).toBeUndefined()
  })
  test('personal packs are not this path', () => {
    expect(teamSkillDeletableSlug(true, 'personal', 'notes')).toBeUndefined()
  })
})
