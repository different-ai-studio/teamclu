import { describe, expect, it } from 'vitest'
import en from '../../../locales/en.json'
import zhCN from '../../../locales/zh-CN.json'
import { TEAM_SKILL_CATEGORIES } from '@/lib/backend/cloud-api/team-skills'
import {
  TEAM_SKILL_CATEGORY_LABEL_KEY,
  teamSkillCategoryLabel,
} from '@/lib/skills/team-skill-category'

const ZH: Record<string, string> = {
  general: '通用',
  coding: '编程',
  devops: '运维',
  data: '数据',
  research: '研究',
  writing: '写作',
  communication: '沟通',
  integration: '集成',
}

const EN: Record<string, string> = {
  general: 'General',
  coding: 'Coding',
  devops: 'DevOps',
  data: 'Data',
  research: 'Research',
  writing: 'Writing',
  communication: 'Communication',
  integration: 'Integration',
}

function translate(catalog: 'en' | 'zh-CN') {
  const bundle = catalog === 'en' ? en.teamShare.skillCategory : zhCN.teamShare.skillCategory
  return (key: string, fallback: string) => {
    const slug = key.split('.').pop() ?? ''
    const value = (bundle as Record<string, string>)[slug]
    return value ?? fallback
  }
}

describe('teamSkillCategoryLabel', () => {
  it('keeps the stored ids and reads each locale from its own catalogue', () => {
    expect([...TEAM_SKILL_CATEGORIES]).toEqual([
      'general',
      'coding',
      'devops',
      'data',
      'research',
      'writing',
      'communication',
      'integration',
    ])
    for (const slug of TEAM_SKILL_CATEGORIES) {
      expect(teamSkillCategoryLabel(slug, translate('zh-CN'))).toBe(ZH[slug])
      expect(teamSkillCategoryLabel(slug, translate('en'))).toBe(EN[slug])
      expect(teamSkillCategoryLabel(slug, translate('zh-CN'))).not.toBe(slug)
      expect(TEAM_SKILL_CATEGORY_LABEL_KEY[slug]).toBe(`teamShare.skillCategory.${slug}`)
    }
  })

  it('leaves an unknown or empty category untouched', () => {
    const t = translate('zh-CN')
    expect(teamSkillCategoryLabel('custom-pack', t)).toBe('custom-pack')
    expect(teamSkillCategoryLabel(null, t)).toBe('')
    expect(teamSkillCategoryLabel(undefined, t)).toBe('')
  })
})
