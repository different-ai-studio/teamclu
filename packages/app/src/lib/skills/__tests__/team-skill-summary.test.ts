import { describe, expect, it } from 'vitest'
import {
  TEAM_SKILL_SUMMARY_MAX,
  clipTeamSkillSummary,
  hydrateTeamSkillPublishFields,
} from '@/lib/skills/team-skill-summary'

const longDescription =
  'Use when the user wants to get or query 抖音来客 (life.douyin.com) merchant order and 核销 data — e.g. asks about store orders, refunds, redemptions, or sales, or wants to set up scraping of their Douyin Life merchant account across stores and date ranges.'

describe('clipTeamSkillSummary', () => {
  it('uses a description that actually exceeds the registry cap', () => {
    expect(longDescription.length).toBeGreaterThan(TEAM_SKILL_SUMMARY_MAX)
  })
  it('leaves a short summary alone', () => {
    expect(clipTeamSkillSummary('发布前检查')).toBe('发布前检查')
  })

  it('never returns more than 200 characters', () => {
    const clipped = clipTeamSkillSummary(longDescription)
    expect(clipped.length).toBeLessThanOrEqual(TEAM_SKILL_SUMMARY_MAX)
    expect(clipped.length).toBeGreaterThan(0)
    expect(longDescription.startsWith(clipped)).toBe(true)
  })

  it('breaks on whitespace instead of mid-word when it can', () => {
    const text = `${'word '.repeat(50)}end`
    const clipped = clipTeamSkillSummary(text)
    expect(clipped.length).toBeLessThanOrEqual(TEAM_SKILL_SUMMARY_MAX)
    expect(clipped.endsWith(' ')).toBe(false)
    expect(clipped.includes('word')).toBe(true)
  })

  it('hard-clips Chinese with no spaces', () => {
    const text = '甲'.repeat(240)
    expect(clipTeamSkillSummary(text)).toBe('甲'.repeat(TEAM_SKILL_SUMMARY_MAX))
  })
})

describe('hydrateTeamSkillPublishFields', () => {
  it('uses a short draft summary as-is', () => {
    expect(
      hydrateTeamSkillPublishFields({
        draftSummary: '  发布前检查  ',
        draftWhenToUse: '发布前确认 CI 绿',
        registrySummary: '旧简介',
        registryWhenToUse: '旧时机',
      }),
    ).toEqual({
      summary: '发布前检查',
      whenToUse: '发布前确认 CI 绿',
      summaryWasClipped: false,
    })
  })

  it('clips a long SKILL.md description and parks the full text in when-to-use', () => {
    const result = hydrateTeamSkillPublishFields({
      draftSummary: longDescription,
      draftWhenToUse: '',
      registrySummary: '',
      registryWhenToUse: '',
    })
    expect(result.summaryWasClipped).toBe(true)
    expect(result.summary.length).toBeLessThanOrEqual(TEAM_SKILL_SUMMARY_MAX)
    expect(result.whenToUse).toBe(longDescription)
  })

  it('keeps an existing when-to-use instead of overwriting it with the long description', () => {
    const result = hydrateTeamSkillPublishFields({
      draftSummary: longDescription,
      draftWhenToUse: '只在查订单时用',
      registrySummary: '',
      registryWhenToUse: '',
    })
    expect(result.whenToUse).toBe('只在查订单时用')
    expect(result.summary.length).toBeLessThanOrEqual(TEAM_SKILL_SUMMARY_MAX)
  })

  it('prefers the registry summary when the draft description is too long', () => {
    const result = hydrateTeamSkillPublishFields({
      draftSummary: longDescription,
      draftWhenToUse: '',
      registrySummary: '抖音来客订单查询',
      registryWhenToUse: '',
    })
    expect(result.summary).toBe('抖音来客订单查询')
    expect(result.whenToUse).toBe(longDescription)
    expect(result.summaryWasClipped).toBe(false)
  })

  it('falls back to registry fields when the draft has nothing', () => {
    expect(
      hydrateTeamSkillPublishFields({
        draftSummary: null,
        draftWhenToUse: undefined,
        registrySummary: 'registry 简介',
        registryWhenToUse: 'registry 时机',
      }),
    ).toEqual({
      summary: 'registry 简介',
      whenToUse: 'registry 时机',
      summaryWasClipped: false,
    })
  })
})
