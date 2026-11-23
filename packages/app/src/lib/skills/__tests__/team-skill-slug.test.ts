import { describe, expect, it } from 'vitest'
import zhCN from '../../../locales/zh-CN.json'
import en from '../../../locales/en.json'
import {
  TEAM_SKILL_SLUG_INVALID_MESSAGE,
  TEAM_SKILL_SLUG_MAX,
  allocateTeamSkillSlug,
  canonicalTeamSkillSlug,
  encodeTeamSkillSlugForPath,
  isPublishableTeamSkillSlug,
  shouldRetirePersonalOnShare,
  skillSlugIssueFromServerMessage,
  teamSkillDisplayName,
  teamSkillSlugFromName,
  teamSkillSlugIssue,
} from '../team-skill-slug'

const CHINESE = '整车成本智能表格'

describe('teamSkillSlugFromName', () => {
  it('keeps a Chinese title as the id', () => {
    expect(teamSkillSlugFromName(CHINESE)).toBe(CHINESE)
    expect(isPublishableTeamSkillSlug(CHINESE)).toBe(true)
    expect(teamSkillSlugFromName(CHINESE.normalize('NFD'))).toBe(CHINESE.normalize('NFC'))
    expect(teamSkillSlugFromName(CHINESE)).not.toMatch(/[a-z]/)
  })

  it('keeps an ASCII slug and still hyphenates spaces', () => {
    expect(teamSkillSlugFromName('deploy-check')).toBe('deploy-check')
    expect(teamSkillSlugFromName('Deploy-Check')).toBe('deploy-check')
    expect(teamSkillSlugFromName('  my skill  ')).toBe('my-skill')
  })

  it('does not transcribe two different Chinese titles into one id', () => {
    expect(teamSkillSlugFromName('知识')).toBe('知识')
    expect(teamSkillSlugFromName('指示')).toBe('指示')
    expect(teamSkillSlugFromName('知识')).not.toBe(teamSkillSlugFromName('指示'))
  })

  it('folds accents to the same NFC id', () => {
    expect(canonicalTeamSkillSlug('Caf\u00e9')).toBe('caf\u00e9')
    expect(canonicalTeamSkillSlug('Cafe\u0301')).toBe('caf\u00e9')
    expect(isPublishableTeamSkillSlug('caf\u00e9')).toBe(true)
  })

  it('does not use a Windows device name as a folder', () => {
    expect(teamSkillSlugFromName('con')).toBe('skill-con')
    expect(teamSkillSlugFromName('NUL')).toBe('skill-nul')
    expect(isPublishableTeamSkillSlug('COM1')).toBe(false)
    expect(isPublishableTeamSkillSlug('console')).toBe(true)
  })

  it('rejects path separators, controls, and trailing dots', () => {
    for (const slug of ['整车/成本', '整车\\成本', 'a/b', '..', 'a?', '整车.', 'a\nb', 'con', 'a:b']) {
      expect(teamSkillSlugIssue(slug), slug).not.toBeNull()
    }
  })

  it('trims surrounding spaces so the folder does not end in a space', () => {
    expect(teamSkillSlugIssue('整车 ')).toBeNull()
    expect(canonicalTeamSkillSlug('整车 ')).toBe('整车')
    expect(canonicalTeamSkillSlug(' 整车')).toBe('整车')
  })

  it('percent-encodes a Chinese id as one path segment', () => {
    const encoded = encodeTeamSkillSlugForPath(CHINESE)
    expect(encoded).not.toContain('/')
    expect(decodeURIComponent(encoded)).toBe(CHINESE)
    expect(encodeTeamSkillSlugForPath('deploy-check')).toBe('deploy-check')
  })

  it('stays inside 64 code points', () => {
    const slug = teamSkillSlugFromName('整'.repeat(80))
    expect([...slug].length).toBeGreaterThan(TEAM_SKILL_SLUG_MAX)
    expect(teamSkillSlugIssue(slug)).toBe('invalid')
    expect(isPublishableTeamSkillSlug('整'.repeat(64))).toBe(true)
    expect(isPublishableTeamSkillSlug('整'.repeat(65))).toBe(false)
  })
})

describe('allocateTeamSkillSlug', () => {
  it('keeps the Chinese id when the team does not have it', () => {
    expect(allocateTeamSkillSlug(CHINESE, new Set())).toBe(CHINESE)
    expect(allocateTeamSkillSlug('deploy-check', new Set(['other']))).toBe('deploy-check')
  })

  it('suffixes a colliding Chinese id', () => {
    expect(allocateTeamSkillSlug(CHINESE, new Set([CHINESE]))).toBe(`${CHINESE}-2`)
    expect(allocateTeamSkillSlug(CHINESE, new Set([CHINESE, `${CHINESE}-2`]))).toBe(`${CHINESE}-3`)
    expect(isPublishableTeamSkillSlug(`${CHINESE}-2`)).toBe(true)
  })
})

describe('teamSkillSlugIssue', () => {
  it('reports empty, invalid, reserved, and taken ids', () => {
    expect(teamSkillSlugIssue('')).toBe('empty')
    expect(teamSkillSlugIssue('   ')).toBe('empty')
    expect(teamSkillSlugIssue(CHINESE)).toBeNull()
    expect(teamSkillSlugIssue('a')).toBe('invalid')
    expect(teamSkillSlugIssue('-ab')).toBe('invalid')
    expect(teamSkillSlugIssue('Has Space')).toBe('invalid')
    expect(teamSkillSlugIssue('CON')).toBe('reserved')
    expect(teamSkillSlugIssue('lpt1')).toBe('reserved')
    expect(teamSkillSlugIssue('deploy-check')).toBeNull()
    expect(teamSkillSlugIssue('Deploy-Check')).toBeNull()
    expect(teamSkillSlugIssue(CHINESE, new Set([CHINESE]))).toBe('taken')
  })

  it('recognises the API error from the share toast', () => {
    expect(skillSlugIssueFromServerMessage(TEAM_SKILL_SLUG_INVALID_MESSAGE)).toBe('invalid')
    expect(
      skillSlugIssueFromServerMessage('slug is reserved on Windows and cannot be a skill folder name'),
    ).toBe('reserved')
    expect(skillSlugIssueFromServerMessage('network down')).toBeNull()
  })
})

describe('shouldRetirePersonalOnShare', () => {
  it('sets the Chinese personal folder aside when it is the same skill', () => {
    expect(shouldRetirePersonalOnShare(CHINESE, CHINESE)).toBe(true)
    expect(shouldRetirePersonalOnShare('deploy-check', 'deploy-check')).toBe(true)
    expect(shouldRetirePersonalOnShare('deploy-check', 'deploy-check-2')).toBe(false)
  })
})

describe('teamSkillDisplayName', () => {
  it('keeps the Chinese title and drops control characters', () => {
    expect(teamSkillDisplayName(CHINESE, CHINESE)).toBe(CHINESE)
    expect(teamSkillDisplayName('  ', CHINESE)).toBe(CHINESE)
    expect(teamSkillDisplayName('整车\n成本', CHINESE)).toBe('整车成本')
    expect(teamSkillDisplayName('名'.repeat(200), 'fallback')).toHaveLength(120)
  })
})

describe('share slug copy', () => {
  it('tells a Chinese user the id can be Chinese', () => {
    const zh = zhCN.teamShare
    expect(zh.skillShareSlug).toBe('标识')
    expect(zh.skillShareSlugInvalid).toContain('中文')
    expect(zh.skillShareSlugInvalid).not.toBe(en.teamShare.skillShareSlugInvalid)
    expect(zh.skillShareSlugReserved).toContain('Windows')
  })
})
