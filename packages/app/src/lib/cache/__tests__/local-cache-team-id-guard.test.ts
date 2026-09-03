import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  reportLocalCacheEmptyTeamId: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/config/platform', () => ({ isChromeExtension: () => false }))

vi.mock('@/lib/telemetry/local-cache-error-report', () => ({
  reportLocalCacheEmptyTeamId: (...args: unknown[]) => mocks.reportLocalCacheEmptyTeamId(...args),
}))

import {
  loadActorsForTeam,
  loadIdeasForTeam,
  loadSessionWorkspacesForTeam,
  loadSessionsForTeam,
} from '@/lib/cache/local-cache'

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue([])
  mocks.reportLocalCacheEmptyTeamId.mockReset()
})

/**
 * A blank team id used to reach the Rust gate and come back as a *gate
 * mismatch* with an empty `requested=`, which reads like the team state
 * diverged when the caller simply had no team yet. Stop it at the boundary.
 */
describe('team-scoped loaders reject a blank team id', () => {
  const cases: Array<[string, (teamId: string) => Promise<unknown[]>]> = [
    ['actor_load_team', (id) => loadActorsForTeam(id)],
    ['session_load_team', (id) => loadSessionsForTeam(id)],
    ['idea_load_team', (id) => loadIdeasForTeam(id)],
    ['session_workspace_load_team', (id) => loadSessionWorkspacesForTeam(id, 'member-1')],
  ]

  for (const [command, call] of cases) {
    it(`${command}: returns empty and reports instead of invoking`, async () => {
      await expect(call('')).resolves.toEqual([])
      await expect(call('   ')).resolves.toEqual([])
      expect(mocks.invoke).not.toHaveBeenCalled()
      expect(mocks.reportLocalCacheEmptyTeamId).toHaveBeenCalledWith(command)
    })
  }

  it('still invokes for a real team id', async () => {
    await loadSessionsForTeam('team-1')
    expect(mocks.invoke).toHaveBeenCalledWith('local_cache_session_load_team', {
      teamId: 'team-1',
      includeDeleted: false,
    })
    expect(mocks.reportLocalCacheEmptyTeamId).not.toHaveBeenCalled()
  })
})
