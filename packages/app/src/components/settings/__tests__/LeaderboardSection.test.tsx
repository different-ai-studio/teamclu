import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { computeTopSkills, LeaderboardSection } from '../LeaderboardSection'
import type { TeamLeaderboard } from '../LeaderboardSection'

const mocks = vi.hoisted(() => ({
  leaderboard: { members: [] } as { members: unknown[] },
  directory: [] as Array<{ id: string; avatar_url?: string | null }>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string | { count?: number; defaultValue?: string }) => {
      if (typeof fallback === 'string') return fallback
      return (fallback?.defaultValue ?? _k).replace('{{count}}', String(fallback?.count ?? ''))
    },
  }),
}))

vi.mock('@/lib/telemetry/cloud-leaderboard', () => ({
  fetchTeamLeaderboard: async () => mocks.leaderboard,
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ team: { id: 'team-1' } }),
    { getState: () => ({ team: { id: 'team-1' } }) },
  ),
}))

vi.mock('@/stores/actor-directory-store', () => ({
  useActorDirectory: () => ({
    actors: mocks.directory,
    loading: false,
    error: false,
    teamId: 'team-1',
    refetch: () => {},
  }),
}))

function member(
  id: string,
  name: string,
  counts: { tokens?: number; feedbacks?: number; skills?: number; apps?: number; invocations?: number },
) {
  return {
    memberId: id,
    memberName: name,
    exportedAt: '',
    updateAt: '',
    skillsPublished: counts.skills ?? 0,
    appsCreated: counts.apps ?? 0,
    workspaces: {
      cloud: {
        totalFeedbacks: counts.feedbacks ?? 0, positiveCount: 0, negativeCount: 0,
        totalTokens: counts.tokens ?? 0, totalCost: 0, sessionCount: 0,
        skillUsage: counts.invocations ? { 'sentry-fix': counts.invocations } : {},
      },
    },
  }
}

/** The row's cells, in column order: #, member, token, feedback, skill, app, total. */
async function rowCells(name: string): Promise<string[]> {
  const nameEl = await screen.findByText(name)
  const row = nameEl.closest('.grid') as HTMLElement
  return Array.from(row.children).map((c) => c.textContent ?? '')
}

describe('LeaderboardSection', () => {
  beforeEach(() => {
    mocks.leaderboard = { members: [] }
    mocks.directory = []
  })

  it('has an App Rank column next to Skill Rank', async () => {
    mocks.leaderboard = { members: [member('a', 'Alice', { skills: 1 })] }
    render(<LeaderboardSection />)
    await screen.findByText('Alice')
    const headers = Array.from(screen.getByText('Skill Rank').parentElement!.children).map((c) => c.textContent)
    expect(headers).toEqual(['#', 'Member', 'Token Rank', 'Feedback Rank', 'Skill Rank', 'App Rank', 'Total Tokens'])
  })

  it('ranks skills by what was published, not by invocations, and apps by apps created', async () => {
    mocks.leaderboard = {
      members: [
        // Alice invokes skills constantly but has published none.
        member('a', 'Alice', { invocations: 500, skills: 0, apps: 3 }),
        member('b', 'Bob', { invocations: 1, skills: 4, apps: 1 }),
      ],
    }
    render(<LeaderboardSection />)

    const alice = await rowCells('Alice')
    const bob = await rowCells('Bob')
    expect([alice[4], alice[5]]).toEqual(['2', '1'])
    expect([bob[4], bob[5]]).toEqual(['1', '2'])
    expect(bob[6]).toContain('4 skills · 1 apps')
    // Invocations still drive the Top Skills list.
    expect(screen.getByText('Top Skills This Team')).toBeInTheDocument()
  })

  it('shows member photos from the directory, the initial otherwise', async () => {
    mocks.leaderboard = { members: [member('a', 'Alice', {}), member('b', 'Bob', {})] }
    mocks.directory = [{ id: 'a', avatar_url: 'https://cdn.example.test/avatars/a.jpg' }, { id: 'b', avatar_url: null }]
    render(<LeaderboardSection />)

    const aliceRow = (await screen.findByText('Alice')).closest('.grid') as HTMLElement
    const bobRow = (await screen.findByText('Bob')).closest('.grid') as HTMLElement
    expect(aliceRow.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.test/avatars/a.jpg')
    expect(bobRow.querySelector('img')).toBeNull()
    expect(bobRow).toHaveTextContent('B')

    fireEvent.error(aliceRow.querySelector('img')!)
    expect(aliceRow.querySelector('img')).toBeNull()
  })
})

describe('computeTopSkills', () => {
  it('aggregates skill counts across all members and workspaces, sorted desc', () => {
    const leaderboard: TeamLeaderboard = {
      members: [
        {
          memberId: 'a',
          memberName: 'Alice',
          exportedAt: '',
          updateAt: '',
          workspaces: {
            '/w1': {
              totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
              totalTokens: 0, totalCost: 0, sessionCount: 0,
              skillUsage: { 'sentry-fix': 10, 'fc-deploy': 5 },
            },
            '/w2': {
              totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
              totalTokens: 0, totalCost: 0, sessionCount: 0,
              skillUsage: { 'sentry-fix': 3 },
            },
          },
        },
        {
          memberId: 'b',
          memberName: 'Bob',
          exportedAt: '',
          updateAt: '',
          workspaces: {
            '/w1': {
              totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
              totalTokens: 0, totalCost: 0, sessionCount: 0,
              skillUsage: { 'fc-deploy': 7 },
            },
          },
        },
      ],
    }

    const top = computeTopSkills(leaderboard, 10)
    expect(top).toEqual([
      { name: 'sentry-fix', count: 13, userCount: 1 },
      { name: 'fc-deploy', count: 12, userCount: 2 },
    ])
  })

  it('returns empty array when no skills are used', () => {
    expect(computeTopSkills({ members: [] }, 10)).toEqual([])
  })

  it('caps at the limit', () => {
    const members = Array.from({ length: 15 }, (_, i) => ({
      memberId: `m${i}`,
      memberName: `M${i}`,
      exportedAt: '', updateAt: '',
      workspaces: {
        '/w': {
          totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
          totalTokens: 0, totalCost: 0, sessionCount: 0,
          skillUsage: { [`skill-${i}`]: i + 1 },
        },
      },
    }))
    const top = computeTopSkills({ members }, 10)
    expect(top).toHaveLength(10)
  })
})
