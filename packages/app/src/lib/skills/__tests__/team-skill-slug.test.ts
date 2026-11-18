import { describe, expect, it } from 'vitest'
import zhCN from '../../../locales/zh-CN.json'
import en from '../../../locales/en.json'
import {
  TEAM_SKILL_SLUG_INVALID_MESSAGE,
  TEAM_SKILL_SLUG_MAX,
  TEAM_SKILL_SLUG_RE,
  allocateTeamSkillSlug,
  isPublishableTeamSkillSlug,
  shouldRetirePersonalOnShare,
  skillSlugIssueFromServerMessage,
  teamSkillDisplayName,
  teamSkillSlugFromName,
  teamSkillSlugIssue,
} from '../team-skill-slug'

const CHINESE = '整车成本智能表格'
const PINYIN = 'zheng-che-cheng-ben-zhi-neng-biao-ge'

describe('teamSkillSlugFromName', () => {
  it('keeps an ASCII slug that is already valid', () => {
    expect(teamSkillSlugFromName('deploy-check')).toBe('deploy-check')
    expect(teamSkillSlugFromName('Deploy-Check')).toBe('deploy-check')
    expect(teamSkillSlugFromName('  my skill  ')).toBe('my-skill')
  })

  it('turns a Chinese title into pinyin so the default id can be shared unchanged', () => {
    const slug = teamSkillSlugFromName(CHINESE)
    expect(slug).toBe(PINYIN)
    expect(slug).toMatch(TEAM_SKILL_SLUG_RE)
    expect(isPublishableTeamSkillSlug(slug)).toBe(true)
    expect([...slug].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true)
    expect(teamSkillSlugFromName(CHINESE.normalize('NFD'))).toBe(slug)
    expect(teamSkillSlugFromName(CHINESE.normalize('NFC'))).toBe(slug)
  })

  it('gives two different Chinese titles two different ids', () => {
    expect(teamSkillSlugFromName(CHINESE)).not.toBe(teamSkillSlugFromName('整车成本智能表'))
  })

  it('disambiguates titles that share a pinyin reading once one id is taken', () => {
    const first = teamSkillSlugFromName('知识')
    const second = allocateTeamSkillSlug('指示', new Set([first, teamSkillSlugFromName('指示')]))
    expect(second).not.toBe(first)
    expect(isPublishableTeamSkillSlug(second)).toBe(true)
  })

  it('folds accents the same way on NFC and NFD, which is how macOS and Windows disagree', () => {
    expect(teamSkillSlugFromName('Café')).toBe('cafe')
    expect(teamSkillSlugFromName('Cafe\u0301')).toBe('cafe')
  })

  it('does not use a Windows device name as a folder', () => {
    expect(teamSkillSlugFromName('con')).toBe('skill-con')
    expect(teamSkillSlugFromName('NUL')).toBe('skill-nul')
    expect(isPublishableTeamSkillSlug(teamSkillSlugFromName('COM1'))).toBe(true)
  })

  it('falls back to a stable hash when the title has no letters', () => {
    const slug = teamSkillSlugFromName('!!!')
    expect(slug).toMatch(/^skill-[0-9a-f]{8}$/)
    expect(teamSkillSlugFromName('!!!')).toBe(slug)
    expect(teamSkillSlugFromName('')).toBe('')
    expect(teamSkillSlugFromName('   ')).toBe('')
  })

  it('stays inside 2-64 characters for a long title', () => {
    const slug = teamSkillSlugFromName('整'.repeat(40))
    expect(slug.length).toBeGreaterThanOrEqual(2)
    expect(slug.length).toBeLessThanOrEqual(TEAM_SKILL_SLUG_MAX)
    expect(slug).toMatch(TEAM_SKILL_SLUG_RE)
    expect(slug).not.toBe(teamSkillSlugFromName('车'.repeat(40)))
  })
})

describe('allocateTeamSkillSlug', () => {
  it('keeps the generated id when the team does not have it', () => {
    expect(allocateTeamSkillSlug(CHINESE, new Set())).toBe(PINYIN)
    expect(allocateTeamSkillSlug('deploy-check', new Set(['other']))).toBe('deploy-check')
  })

  it('suffixes a colliding id, including a generated Chinese one', () => {
    expect(allocateTeamSkillSlug('deploy-check', new Set(['deploy-check']))).toBe('deploy-check-2')
    expect(allocateTeamSkillSlug(CHINESE, new Set([PINYIN, `${PINYIN}-2`]))).toBe(`${PINYIN}-3`)
  })

  it('fits a suffix into the 64 character limit', () => {
    const base = `a${'b'.repeat(63)}`
    expect(base).toHaveLength(64)
    const allocated = allocateTeamSkillSlug(base, new Set([base]))
    expect(allocated).toMatch(TEAM_SKILL_SLUG_RE)
    expect(allocated).not.toBe(base)
    expect(allocated.endsWith('-2')).toBe(true)
    expect(allocated.length).toBeLessThanOrEqual(64)
  })
})

describe('teamSkillSlugIssue', () => {
  it('reports empty, invalid, reserved, and taken ids', () => {
    expect(teamSkillSlugIssue('')).toBe('empty')
    expect(teamSkillSlugIssue('   ')).toBe('empty')
    expect(teamSkillSlugIssue(CHINESE)).toBe('invalid')
    expect(teamSkillSlugIssue('a')).toBe('invalid')
    expect(teamSkillSlugIssue('-ab')).toBe('invalid')
    expect(teamSkillSlugIssue('Has Space')).toBe('invalid')
    expect(teamSkillSlugIssue('CON')).toBe('reserved')
    expect(teamSkillSlugIssue('lpt1')).toBe('reserved')
    expect(teamSkillSlugIssue('deploy-check')).toBeNull()
    expect(teamSkillSlugIssue('Deploy-Check')).toBeNull()
    expect(teamSkillSlugIssue('deploy-check', new Set(['deploy-check']))).toBe('taken')
    expect(teamSkillSlugIssue('console')).toBeNull()
  })

  it('recognises the API error from the share toast', () => {
    expect(skillSlugIssueFromServerMessage(TEAM_SKILL_SLUG_INVALID_MESSAGE)).toBe('invalid')
    expect(
      skillSlugIssueFromServerMessage(
        'slug must be 2-64 chars of [a-z0-9-] and start with a letter or digit',
      ),
    ).toBe('invalid')
    expect(
      skillSlugIssueFromServerMessage('slug is reserved on Windows and cannot be a skill folder name'),
    ).toBe('reserved')
    expect(skillSlugIssueFromServerMessage('network down')).toBeNull()
  })
})

describe('shouldRetirePersonalOnShare', () => {
  it('sets a Chinese personal folder aside and keeps a deliberate ASCII rename', () => {
    expect(shouldRetirePersonalOnShare(CHINESE, PINYIN)).toBe(true)
    expect(shouldRetirePersonalOnShare('deploy-check', 'deploy-check')).toBe(true)
    expect(shouldRetirePersonalOnShare('deploy-check', 'deploy-check-2')).toBe(false)
    expect(shouldRetirePersonalOnShare('con', 'skill-con')).toBe(true)
  })
})

describe('teamSkillDisplayName', () => {
  it('keeps the Chinese title and drops control characters', () => {
    expect(teamSkillDisplayName(CHINESE, PINYIN)).toBe(CHINESE)
    expect(teamSkillDisplayName('  ', PINYIN)).toBe(PINYIN)
    expect(teamSkillDisplayName(`整车\n成本`, PINYIN)).toBe('整车成本')
    expect(teamSkillDisplayName('名'.repeat(200), 'fallback')).toHaveLength(120)
  })
})

describe('share slug copy', () => {
  it('localizes the validation the dialog used to show in English', () => {
    const zh = zhCN.teamShare
    const english = en.teamShare
    expect(zh.skillShareSlug).toBe('标识')
    expect(zh.skillShareSlugInvalid).not.toBe(english.skillShareSlugInvalid)
    expect(zh.skillShareSlugInvalid).toContain('小写字母')
    expect(zh.skillShareSlugEmpty).toContain('标识')
    expect(zh.skillShareSlugGenerated).toContain('Windows')
    expect(zh.skillShareSlugGenerated).toContain('macOS')
    expect(zh.skillShareSlugReserved).toContain('Windows')
  })
})
