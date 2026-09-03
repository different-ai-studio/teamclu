type RankDirection = 'asc' | 'desc'

function normalizeScore(score: number | undefined | null): number {
  return typeof score === 'number' && Number.isFinite(score) ? score : 0
}

export function buildSharedRankMap<T>({
  items,
  getKey,
  getScore,
  direction = 'desc',
}: {
  items: readonly T[]
  getKey: (item: T) => string
  getScore: (item: T) => number | undefined | null
  direction?: RankDirection
}): Map<string, number> {
  const sortedItems = [...items].sort((a, b) => {
    const scoreA = normalizeScore(getScore(a))
    const scoreB = normalizeScore(getScore(b))
    return direction === 'asc' ? scoreA - scoreB : scoreB - scoreA
  })

  const ranks = new Map<string, number>()
  let currentRank = 0
  let previousScore: number | null = null

  sortedItems.forEach((item, index) => {
    const score = normalizeScore(getScore(item))

    if (previousScore === null || score !== previousScore) {
      currentRank = index + 1
      previousScore = score
    }

    ranks.set(getKey(item), currentRank)
  })

  return ranks
}
