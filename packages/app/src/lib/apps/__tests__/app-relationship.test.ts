import { describe, expect, it } from 'vitest'
import {
  appRelationship,
  countAppsByRelationship,
  filterAppsByRelationship,
  keepRelationship,
} from '@/lib/apps/app-relationship'
import type { AppRow } from '@/lib/backend/types'

const ME = 'actor-me'

function app(over: Partial<AppRow>): AppRow {
  return {
    id: 'app',
    visibility: 'team',
    createdByActorId: 'actor-lin',
    ...over,
  } as AppRow
}

describe('appRelationship', () => {
  it('uses the server answer when there is one', () => {
    // Created by me AND team, but the server said invited — it knows the grants.
    expect(appRelationship(app({ relationship: 'invited', createdByActorId: ME }), ME)).toBe('invited')
  })

  it('works it out on a server that does not send it: mine, then team, then invited', () => {
    expect(appRelationship(app({ createdByActorId: ME, visibility: 'team' }), ME)).toBe('owner')
    expect(appRelationship(app({ visibility: 'team' }), ME)).toBe('team')
    // Visible, not mine, not team: only a grant lets that row through.
    expect(appRelationship(app({ visibility: 'personal' }), ME)).toBe('invited')
  })

  it('reads a personal app as mine while my actor id is still unknown', () => {
    expect(appRelationship(app({ visibility: 'personal' }), null)).toBe('owner')
    expect(appRelationship(app({ visibility: 'team' }), null)).toBe('team')
  })
})

describe('countAppsByRelationship / filterAppsByRelationship', () => {
  const items = [
    app({ id: 'a', relationship: 'owner' }),
    app({ id: 'b', relationship: 'invited' }),
    app({ id: 'c', relationship: 'team' }),
    app({ id: 'd', relationship: 'team' }),
  ]

  it('counts each app once, under one relationship', () => {
    expect(countAppsByRelationship(items, ME)).toEqual({ all: 4, owner: 1, invited: 1, team: 2 })
  })

  it('filters to one relationship, and all is everything', () => {
    expect(filterAppsByRelationship(items, 'team', ME).map((a) => a.id)).toEqual(['c', 'd'])
    expect(filterAppsByRelationship(items, 'all', ME)).toBe(items)
  })
})

describe('keepRelationship', () => {
  it('keeps the relationship a mutation response left out', () => {
    const prev = app({ relationship: 'invited', invitedByActorId: 'actor-lin' })
    const next = app({ name: 'renamed' })
    expect(keepRelationship(prev, next)).toMatchObject({
      name: 'renamed',
      relationship: 'invited',
      invitedByActorId: 'actor-lin',
    })
  })

  it('takes the new answer when the response carries one', () => {
    const prev = app({ relationship: 'invited', invitedByActorId: 'actor-lin' })
    const next = app({ relationship: 'team', invitedByActorId: null })
    expect(keepRelationship(prev, next)).toBe(next)
  })
})
