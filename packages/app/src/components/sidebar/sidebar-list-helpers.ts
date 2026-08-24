import type { IdeaRow } from '@/components/panel/IdeasView'

export function getTopIdeas(ideas: IdeaRow[]): IdeaRow[] {
  return [...ideas]
    .sort((a, b) => {
      const bySortOrder = (a.sort_order ?? 0) - (b.sort_order ?? 0)
      if (bySortOrder !== 0) return bySortOrder
      const byUpdatedAt = b.updated_at.localeCompare(a.updated_at)
      if (byUpdatedAt !== 0) return byUpdatedAt
      return a.id.localeCompare(b.id)
    })
    .slice(0, 10)
}
