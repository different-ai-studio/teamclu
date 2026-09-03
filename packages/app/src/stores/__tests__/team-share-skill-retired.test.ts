import { describe, test, expect, beforeEach, vi } from 'vitest'

/**
 * What a member sees when somebody else deletes a team skill they had installed.
 *
 * Driven through the real `reconcileSkills`, not a stub: the whole question is
 * whether the reconcile can tell three look-alike situations apart — the team
 * deleted it, I uninstalled it, I deleted it myself — and a stub would be
 * asserting the test's own opinion instead.
 */

let registry: Array<Record<string, unknown>> = []
let onDisk: Array<Record<string, unknown>> = []
let inspect: Record<string, string> = {}
const uninstalled: string[] = []

const listTeamSkills = vi.fn(async () => registry)
const installTeamSkill = vi.fn(async () => ({}))
const deleteTeamSkill = vi.fn(async () => {
  registry = []
})

vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({ teamSkills: { listTeamSkills, installTeamSkill, deleteTeamSkill } }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === 'team_skill_list_installed') return onDisk
    if (cmd === 'team_skill_inspect') {
      return {
        slug: args.slug,
        state: inspect[args.slug] ?? 'clean',
        installedVersion: String(args.expectedVersion ?? 1),
        modified: [],
        deleted: [],
        added: [],
      }
    }
    if (cmd === 'team_skill_uninstall') {
      uninstalled.push(args.slug)
      onDisk = onDisk.filter((p) => p.slug !== args.slug)
      return null
    }
    return null
  }),
}))

vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => 'agent-1',
}))

vi.mock('@/lib/workspace/effective-workspace', () => ({
  effectiveWorkspacePath: async () => '/ws',
  useEffectiveWorkspacePath: () => '/ws',
}))

import { CloudApiError } from '@/lib/backend/cloud-api/http'
import { useTeamShareBrowserStore } from '../team-share-browser'
import { useCurrentTeamStore } from '../current-team'

const store = () => useTeamShareBrowserStore.getState()
const TEAM = 'team-1'

describe('a team skill deleted out from under this machine', () => {
  beforeEach(() => {
    listTeamSkills.mockClear()
    deleteTeamSkill.mockClear()
    uninstalled.length = 0
    inspect = {}
    registry = []
    onDisk = [{ slug: 'deploy-check', version: '3', teamId: TEAM }]
    useCurrentTeamStore.setState({ team: { id: TEAM } } as never)
    useTeamShareBrowserStore.setState({
      skillRetired: {},
      skillLocalState: {},
      skillArchived: {},
      skillSyncErrors: {},
      skills: { items: [], loading: false, loaded: true, error: null } as never,
      loadSection: async () => {},
    })
  })

  test('the pack is uninstalled and recorded as removed', async () => {
    await store().reconcileSkills()

    expect(uninstalled).toEqual(['deploy-check'])
    expect(store().skillRetired).toEqual({ 'deploy-check': 'removed' })
  })

  test('an ordinary uninstall is not reported as a deletion', async () => {
    // Same disk, same removal — but the skill is still in the registry, so this
    // member did it to themselves and needs no notice.
    registry = [
      { slug: 'deploy-check', latestVersion: 3, installed: false, installedVersion: null },
    ]

    await store().reconcileSkills()

    expect(uninstalled).toEqual(['deploy-check'])
    expect(store().skillRetired).toEqual({})
  })

  test('a pack with local edits is kept, and says so instead', async () => {
    inspect['deploy-check'] = 'dirty'

    await store().reconcileSkills()

    expect(uninstalled).toEqual([])
    expect(store().skillRetired).toEqual({ 'deploy-check': 'kept' })
  })

  test('the person who pressed delete is not told their own news', async () => {
    useTeamShareBrowserStore.setState({
      skills: {
        items: [{ slug: 'deploy-check', origin: 'registry' }] as never,
        loading: false,
        loaded: true,
        error: null,
      },
    })

    await store().deleteTeamSkill('deploy-check')

    expect(uninstalled).toEqual(['deploy-check'])
    expect(store().skillRetired).toEqual({})
  })

  test('but they are told when their own edits survived the delete', async () => {
    // The delete confirmation says the skill is gone team-wide. It does not say
    // "and your edited copy is still here as a personal skill", which is the
    // part that would otherwise be a surprise.
    inspect['deploy-check'] = 'dirty'
    useTeamShareBrowserStore.setState({
      skills: {
        items: [{ slug: 'deploy-check', origin: 'registry' }] as never,
        loading: false,
        loaded: true,
        error: null,
      },
    })

    await store().deleteTeamSkill('deploy-check')

    expect(store().skillRetired).toEqual({ 'deploy-check': 'kept' })
  })

  test('an unreachable registry is never read as a mass deletion', async () => {
    listTeamSkills.mockImplementationOnce(async () => {
      throw new Error('offline')
    })

    await store().reconcileSkills()

    expect(uninstalled).toEqual([])
    expect(store().skillRetired).toEqual({})
  })

  test('dismissing clears the record', async () => {
    await store().reconcileSkills()
    store().dismissRetired('deploy-check')
    expect(store().skillRetired).toEqual({})
  })

  test('an expired session is not swallowed as a transient fetch failure', async () => {
    listTeamSkills.mockRejectedValue(
      new CloudApiError(401, 'missing_auth', 'Missing auth session access token.', null),
    )
    await expect(store().reconcileSkills()).rejects.toBeInstanceOf(CloudApiError)
    expect(uninstalled).toEqual([])
  })
})
