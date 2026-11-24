import { SelectItem, SelectValue } from '@/components/ui/select'
import { TEAM_SKILL_CATEGORIES } from '@/lib/backend/cloud-api/team-skills'
import { useTeamSkillCategoryLabel } from '@/lib/skills/team-skill-category'

/** Option rows for a skill-category select. `value` stays the stored slug. */
export function TeamSkillCategorySelectItems({ itemClassName }: { itemClassName?: string }) {
  const categoryLabel = useTeamSkillCategoryLabel()
  return TEAM_SKILL_CATEGORIES.map((category) => (
    <SelectItem key={category} value={category} className={itemClassName}>
      {categoryLabel(category)}
    </SelectItem>
  ))
}

/**
 * Closed-state label. Radix otherwise paints the raw value until the menu
 * has mounted an item, which is exactly the English slug on a Chinese UI.
 */
export function TeamSkillCategorySelectValue({ category }: { category: string }) {
  const categoryLabel = useTeamSkillCategoryLabel()
  return <SelectValue>{categoryLabel(category)}</SelectValue>
}
