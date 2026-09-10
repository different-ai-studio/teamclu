/**
 * An app's directory has to be resolvable from the app's own cloud workspace
 * row.
 *
 * The cloud API creates that row (`apps.workspace_id`) with a name and no path,
 * because it never sees a filesystem. A path-less workspace is one the daemon
 * cannot resolve, so `apply_start_runtime` fell through to whatever `worktree`
 * the desktop sent — and when the desktop had nothing bound, that was the
 * workspace the user happened to have open. The app's files were then written
 * into someone's project folder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listWorkspacesByIds: vi.fn(),
  listDaemonWorkspaces: vi.fn(),
  createDaemonWorkspace: vi.fn(),
  getLocalDaemonActorId: vi.fn(),
  resolveCurrentMemberActorId: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ workspaces: { listWorkspacesByIds: mocks.listWorkspacesByIds } }),
}))

vi.mock('@/lib/daemon/daemon-workspaces', () => ({
  listDaemonWorkspaces: mocks.listDaemonWorkspaces,
  createDaemonWorkspace: mocks.createDaemonWorkspace,
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: mocks.getLocalDaemonActorId,
}))

vi.mock('@/lib/actor/current-actor', () => ({
  resolveCurrentMemberActorId: mocks.resolveCurrentMemberActorId,
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-1' }, currentMember: { id: 'member-1' } }),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: 'user-1' } } }) },
}))

const WORKDIR = '/home/u/.amuxd/teams/team-1/apps/app-1'

const app = (over: Record<string, unknown> = {}) =>
  ({
    id: 'app-1',
    teamId: 'team-1',
    name: 'My App',
    slug: 'my-app',
    type: 'static_web',
    visibility: 'team',
    workspaceId: 'ws-app-1',
    gitRemoteUrl: null,
    provisionStatus: 'ready',
    fcStatus: null,
    fcEndpoint: null,
    publicUrl: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as never

describe('bindAppWorkdir', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLocalDaemonActorId.mockResolvedValue('daemon-actor-1')
    mocks.resolveCurrentMemberActorId.mockResolvedValue('member-actor-1')
    mocks.listWorkspacesByIds.mockResolvedValue([{ id: 'ws-app-1', name: 'app-my-app-ab12', path: null }])
    mocks.createDaemonWorkspace.mockImplementation(async (input) => ({ ...input, id: input.id ?? 'ws-new' }))
    mocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it("writes the checkout path onto the app's own workspace row", async () => {
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    const id = await bindAppWorkdir(app(), WORKDIR)

    expect(id).toBe('ws-app-1')
    expect(mocks.createDaemonWorkspace).toHaveBeenCalledWith(
      // The id is what makes this an upsert of the app's row rather than a
      // second workspace pointing at the same directory.
      expect.objectContaining({ id: 'ws-app-1', path: WORKDIR, agentId: 'daemon-actor-1' }),
    )
  })

  it("keeps the row's existing name", async () => {
    // `workspaces` is unique on (team_id, agent_id, name); renaming the row to
    // the app's name here could collide with a workspace the user already has.
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    await bindAppWorkdir(app(), WORKDIR)
    expect(mocks.createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-my-app-ab12' }),
    )
  })

  it('writes nothing when the row already names that directory', async () => {
    mocks.listWorkspacesByIds.mockResolvedValueOnce([{ id: 'ws-app-1', name: 'w', path: WORKDIR }])
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    const id = await bindAppWorkdir(app(), WORKDIR)

    expect(id).toBe('ws-app-1')
    expect(mocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })

  it('falls back to a workspace of its own for an app row with no workspace', async () => {
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    const id = await bindAppWorkdir(app({ workspaceId: null }), WORKDIR)

    expect(id).toBe('ws-new')
    expect(mocks.createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ path: WORKDIR, name: 'My App' }),
    )
    expect(mocks.createDaemonWorkspace.mock.calls[0][0].id).toBeUndefined()
  })

  it('reuses an existing workspace already pointing at the directory', async () => {
    mocks.listDaemonWorkspaces.mockResolvedValueOnce([
      { id: 'ws-existing', path: WORKDIR, archived: false },
    ])
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    const id = await bindAppWorkdir(app({ workspaceId: null }), WORKDIR)

    expect(id).toBe('ws-existing')
    expect(mocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })

  it('never throws when the cloud is unreachable — seeding already succeeded', async () => {
    mocks.listWorkspacesByIds.mockRejectedValueOnce(new Error('offline'))
    mocks.listDaemonWorkspaces.mockRejectedValueOnce(new Error('offline'))
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    await expect(bindAppWorkdir(app(), WORKDIR)).resolves.toBeNull()
  })

  it('does nothing without a workdir', async () => {
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    expect(await bindAppWorkdir(app(), '   ')).toBeNull()
    expect(mocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })
})

/**
 * The same account on two computers is two daemons, two checkouts and two
 * absolute paths — against a single `apps.workspace_id`. Whoever opened the app
 * last used to overwrite that row with their own machine's path and agent,
 * which re-pointed the other machine's sessions at a directory it does not
 * have.
 */
describe('bindAppWorkdir on a second machine', () => {
  const OTHER_MACHINE = '/Users/someone-else/.amuxd/teams/team-1/apps/app-1'

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLocalDaemonActorId.mockResolvedValue('daemon-actor-2')
    mocks.resolveCurrentMemberActorId.mockResolvedValue('member-actor-1')
    mocks.createDaemonWorkspace.mockImplementation(async (input) => ({
      ...input,
      id: input.id ?? 'ws-new',
    }))
    mocks.listDaemonWorkspaces.mockResolvedValue([])
  })

  it("leaves the other machine's row alone and takes one of its own", async () => {
    mocks.listWorkspacesByIds.mockResolvedValue([
      { id: 'ws-app-1', name: 'app-my-app-ab12', path: OTHER_MACHINE },
    ])
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')
    const id = await bindAppWorkdir(app(), WORKDIR)

    expect(id).toBe('ws-new')
    // One call, and it is an insert (no `id`) — the app's own row is untouched.
    expect(mocks.createDaemonWorkspace).toHaveBeenCalledTimes(1)
    const input = mocks.createDaemonWorkspace.mock.calls[0][0]
    expect(input.id).toBeUndefined()
    expect(input).toMatchObject({ path: WORKDIR, agentId: 'daemon-actor-2' })
  })

  it('reuses this machine\'s own row once it exists', async () => {
    mocks.listWorkspacesByIds.mockResolvedValue([
      { id: 'ws-app-1', name: 'app-my-app-ab12', path: OTHER_MACHINE },
    ])
    mocks.listDaemonWorkspaces.mockResolvedValue([
      { id: 'ws-mine', path: WORKDIR, archived: false },
    ])
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')

    expect(await bindAppWorkdir(app(), WORKDIR)).toBe('ws-mine')
    expect(mocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })

  it('still claims a row no machine has bound to a directory yet', async () => {
    // The path-less row the cloud API minted with the app. Nobody owns it, so
    // whichever machine gets there first fills it in — that is the whole point
    // of it existing.
    mocks.listWorkspacesByIds.mockResolvedValue([
      { id: 'ws-app-1', name: 'app-my-app-ab12', path: null },
    ])
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')

    expect(await bindAppWorkdir(app(), WORKDIR)).toBe('ws-app-1')
    expect(mocks.createDaemonWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ws-app-1', path: WORKDIR, agentId: 'daemon-actor-2' }),
    )
  })

  it('shares one row when both machines lay their home out identically', async () => {
    // Same absolute path on both: the row resolves correctly on each, and a
    // second row for the same directory would be the confusing thing.
    mocks.listWorkspacesByIds.mockResolvedValue([
      { id: 'ws-app-1', name: 'app-my-app-ab12', path: WORKDIR },
    ])
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')

    expect(await bindAppWorkdir(app(), WORKDIR)).toBe('ws-app-1')
    expect(mocks.createDaemonWorkspace).not.toHaveBeenCalled()
  })

  it("never answers with the other machine's workspace id", async () => {
    // A wrong workspace resolves to a directory that is not here; no workspace
    // at all lets runtime-start fall back to the worktree it was given.
    mocks.listWorkspacesByIds.mockResolvedValue([
      { id: 'ws-app-1', name: 'w', path: OTHER_MACHINE },
    ])
    mocks.listDaemonWorkspaces.mockRejectedValue(new Error('offline'))
    const { bindAppWorkdir } = await import('@/lib/apps/app-session')

    expect(await bindAppWorkdir(app(), WORKDIR)).toBeNull()
  })
})
