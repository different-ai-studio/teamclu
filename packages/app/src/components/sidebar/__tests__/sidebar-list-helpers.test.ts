import { describe, expect, it } from 'vitest'
import type { IdeaRow } from '@/components/panel/IdeasView'
import { getTopIdeas } from '../sidebar-list-helpers'

function idea(id: string, sortOrder: number, updatedAt = '2026-05-01T00:00:00Z'): IdeaRow {
  return {
    id,
    title: id,
    status: 'open',
    created_by_actor_id: 'actor-1',
    sort_order: sortOrder,
    updated_at: updatedAt,
  }
}

describe('sidebar list helpers', () => {
  it('returns the top 10 ideas by highest rank', () => {
    const ideas = Array.from({ length: 12 }, (_, index) =>
      idea(`idea-${index + 1}`, (12 - index) * 1000),
    )

    expect(getTopIdeas(ideas).map((row) => row.id)).toEqual([
      'idea-12',
      'idea-11',
      'idea-10',
      'idea-9',
      'idea-8',
      'idea-7',
      'idea-6',
      'idea-5',
      'idea-4',
      'idea-3',
    ])
  })
})
