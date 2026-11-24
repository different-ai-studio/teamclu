import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TEAM_SKILL_CATEGORIES, type TeamSkillCategory } from '@/lib/backend/cloud-api/team-skills'

/**
 * Display copy for the fixed skill-category ids.
 *
 * The stored value, the API, and validation stay the slug (`general`,
 * `coding`, …). These keys are only what a person sees.
 */
export const TEAM_SKILL_CATEGORY_LABEL_KEY: Record<TeamSkillCategory, string> = {
  general: 'teamShare.skillCategory.general',
  coding: 'teamShare.skillCategory.coding',
  devops: 'teamShare.skillCategory.devops',
  data: 'teamShare.skillCategory.data',
  research: 'teamShare.skillCategory.research',
  writing: 'teamShare.skillCategory.writing',
  communication: 'teamShare.skillCategory.communication',
  integration: 'teamShare.skillCategory.integration',
}

/** English fallback, matching `en.json`, for callers that render before the catalogue loads. */
const TEAM_SKILL_CATEGORY_FALLBACK: Record<TeamSkillCategory, string> = {
  general: 'General',
  coding: 'Coding',
  devops: 'DevOps',
  data: 'Data',
  research: 'Research',
  writing: 'Writing',
  communication: 'Communication',
  integration: 'Integration',
}

type CategoryTranslator = (key: string, fallback: string) => string

export function isTeamSkillCategory(value: string): value is TeamSkillCategory {
  return (TEAM_SKILL_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Localized name for a skill category. Unknown strings are returned as stored
 * so a value outside the fixed set is still visible.
 */
export function teamSkillCategoryLabel(
  category: string | null | undefined,
  t: CategoryTranslator,
): string {
  if (!category) return ''
  if (!isTeamSkillCategory(category)) return category
  return t(TEAM_SKILL_CATEGORY_LABEL_KEY[category], TEAM_SKILL_CATEGORY_FALLBACK[category])
}

/** Label function bound to the current UI language. */
export function useTeamSkillCategoryLabel(): (category: string | null | undefined) => string {
  const { t } = useTranslation()
  return React.useCallback(
    (category: string | null | undefined) =>
      teamSkillCategoryLabel(category, (key, fallback) => t(key, fallback)),
    [t],
  )
}
