import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertSkillUsageMock = vi.fn()
const resolveCurrentMemberActorIdMock = vi.fn()

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: { id: 'team-abc' } }) },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: 'user-xyz' } } }) },
}))

vi.mock('@/lib/actor/current-actor', () => ({
  resolveCurrentMemberActorId: (...args: unknown[]) => resolveCurrentMemberActorIdMock(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    telemetry: { insertSkillUsage: (...args: unknown[]) => insertSkillUsageMock(...args) },
  }),
}))

/**
 * Ported from the deleted local-stats store's tests: the cloud half of skill
 * reporting is the half that still exists, and it is the only thing that fills
 * the leaderboard's skill dimension.
 */
describe('reportSkillUsage', () => {
  beforeEach(() => {
    insertSkillUsageMock.mockReset()
    insertSkillUsageMock.mockResolvedValue(undefined)
    resolveCurrentMemberActorIdMock.mockReset()
    resolveCurrentMemberActorIdMock.mockResolvedValue('actor-123')
  })

  it('reports with the resolved actor, team, skill and a count of 1', async () => {
    const { reportSkillUsage } = await import('@/lib/telemetry/skill-usage')

    await reportSkillUsage('sentry-fix')

    expect(resolveCurrentMemberActorIdMock).toHaveBeenCalledWith('team-abc', 'user-xyz')
    expect(insertSkillUsageMock).toHaveBeenCalledWith({
      actorId: 'actor-123',
      teamId: 'team-abc',
      skill: 'sentry-fix',
      count: 1,
    })
  })

  // It runs inside the live-event handler; a telemetry failure must not surface.
  it('swallows a cloud failure', async () => {
    insertSkillUsageMock.mockRejectedValue(new Error('network error'))
    const { reportSkillUsage } = await import('@/lib/telemetry/skill-usage')

    await expect(reportSkillUsage('sentry-fix')).resolves.toBeUndefined()
  })

  it('skips when the actor cannot be resolved', async () => {
    resolveCurrentMemberActorIdMock.mockResolvedValue(null)
    const { reportSkillUsage } = await import('@/lib/telemetry/skill-usage')

    await reportSkillUsage('sentry-fix')

    expect(insertSkillUsageMock).not.toHaveBeenCalled()
  })

  it('skips an empty skill name', async () => {
    const { reportSkillUsage } = await import('@/lib/telemetry/skill-usage')

    await reportSkillUsage('')

    expect(resolveCurrentMemberActorIdMock).not.toHaveBeenCalled()
    expect(insertSkillUsageMock).not.toHaveBeenCalled()
  })
})
