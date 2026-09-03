import { describe, expect, it } from 'vitest'

import { buildSharedRankMap } from '@/lib/team/team-leaderboard-ranks'

describe('buildSharedRankMap', () => {
  it('assigns the same rank to equal scores', () => {
    const members = [
      { id: 'alice', score: 0 },
      { id: 'bob', score: 0 },
      { id: 'carol', score: 0 },
    ]

    const ranks = buildSharedRankMap({
      items: members,
      getKey: (member) => member.id,
      getScore: (member) => member.score,
    })

    expect(ranks.get('alice')).toBe(1)
    expect(ranks.get('bob')).toBe(1)
    expect(ranks.get('carol')).toBe(1)
  })

  it('keeps overall ranking correct when feedback scores are tied', () => {
    const members = [
      { id: 'alice', tokenScore: 200, feedbackScore: 0 },
      { id: 'bob', tokenScore: 120, feedbackScore: 0 },
      { id: 'carol', tokenScore: 120, feedbackScore: 0 },
    ]

    const tokenRanks = buildSharedRankMap({
      items: members,
      getKey: (member) => member.id,
      getScore: (member) => member.tokenScore,
    })
    const feedbackRanks = buildSharedRankMap({
      items: members,
      getKey: (member) => member.id,
      getScore: (member) => member.feedbackScore,
    })
    const overallScores = members.map((member) => ({
      id: member.id,
      overallScore: ((tokenRanks.get(member.id) ?? 0) + (feedbackRanks.get(member.id) ?? 0)) / 2,
    }))
    const overallRanks = buildSharedRankMap({
      items: overallScores,
      getKey: (member) => member.id,
      getScore: (member) => member.overallScore,
      direction: 'asc',
    })

    expect(tokenRanks.get('alice')).toBe(1)
    expect(tokenRanks.get('bob')).toBe(2)
    expect(tokenRanks.get('carol')).toBe(2)

    expect(feedbackRanks.get('alice')).toBe(1)
    expect(feedbackRanks.get('bob')).toBe(1)
    expect(feedbackRanks.get('carol')).toBe(1)

    expect(overallRanks.get('alice')).toBe(1)
    expect(overallRanks.get('bob')).toBe(2)
    expect(overallRanks.get('carol')).toBe(2)
  })
})
