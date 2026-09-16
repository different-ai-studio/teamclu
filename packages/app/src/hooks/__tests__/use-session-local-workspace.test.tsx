import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  currentSessionId: 'sess-a' as string | null,
  teamId: 'team-1' as string | null,
  workspacePath: '/tmp/a' as string | null,
  participantsBySession: {} as Record<string, Array<{ actorId: string; displayName: string }>>,
  ensureParticipants: vi.fn(),
  getLocalDaemonActorId: vi.fn(),
  resolveSessionWorkspacePath: vi.fn(),
  localSeatNeedsWorkspace: vi.fn(),
}))

vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ currentSessionId: mocks.currentSessionId }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({ team: mocks.teamId ? { id: mocks.teamId } : null }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ workspacePath: mocks.workspacePath }),
}))

vi.mock('@/stores/session-participant-store', () => ({
  useSessionParticipantStore: (selector: (s: unknown) => unknown) =>
    selector({
      participantsBySession: mocks.participantsBySession,
      ensureParticipants: mocks.ensureParticipants,
    }),
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: () => mocks.getLocalDaemonActorId(),
}))

vi.mock('@/lib/session/session-by-workspace', () => ({
  resolveSessionWorkspacePath: (...args: unknown[]) => mocks.resolveSessionWorkspacePath(...args),
}))

vi.mock('@/lib/session/session-agent-workspace', () => ({
  localSeatNeedsWorkspace: (...args: unknown[]) => mocks.localSeatNeedsWorkspace(...args),
}))

import { noteSessionWorkspaceRebound } from '@/lib/session/session-workspace-rebind'
import {
  __resetLocalDaemonIdentityForTest,
  noteLocalDaemonActorId,
} from '@/lib/daemon/local-daemon-identity'
import { useSessionLocalWorkspace } from '../use-session-local-workspace'

describe('useSessionLocalWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.currentSessionId = 'sess-a'
    mocks.teamId = 'team-1'
    mocks.workspacePath = '/tmp/a'
    __resetLocalDaemonIdentityForTest()
    noteLocalDaemonActorId('agent-local')
    mocks.getLocalDaemonActorId.mockResolvedValue(null)
    mocks.participantsBySession = {
      'sess-a': [{ actorId: 'agent-local', displayName: 'Mac-mini-3' }],
      'sess-b': [{ actorId: 'agent-local', displayName: 'Mac-mini-3' }],
    }
    mocks.resolveSessionWorkspacePath.mockImplementation(async (_team: string, id: string) =>
      id === 'sess-a' ? '/tmp/a' : '/tmp/b',
    )
    mocks.localSeatNeedsWorkspace.mockResolvedValue(true)
  })

  it('reports the session folder once the workspace store agrees', async () => {
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.path).toBe('/tmp/a'))
    expect(result.current.hasLocalAgent).toBe(true)
    expect(result.current.agentId).toBe('agent-local')
    expect(result.current.agentName).toBe('Mac-mini-3')
    expect(result.current.bindingResolved).toBe(true)
    expect(result.current.boundPath).toBe('/tmp/a')
  })

  // The tree renders from the workspace store while the footer names the
  // binding. `switchToSessionWorkspaceIfNeeded` moves the store in the
  // background, so reporting the binding early labels one folder's name over
  // another folder's tree.
  it('withholds the path while the workspace store still points elsewhere', async () => {
    const { result, rerender } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.path).toBe('/tmp/a'))

    mocks.currentSessionId = 'sess-b'
    rerender()

    await waitFor(() => expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalledWith('team-1', 'sess-b'))
    // Store has not followed yet: no path, and crucially never '/tmp/a'.
    await waitFor(() => expect(result.current.boundPath).toBe('/tmp/b'))
    expect(result.current.path).toBeNull()
    expect(result.current.hasLocalAgent).toBe(true)
    expect(result.current.bindingResolved).toBe(true)

    mocks.workspacePath = '/tmp/b'
    rerender()
    await waitFor(() => expect(result.current.path).toBe('/tmp/b'))
  })

  // An app session's seat is moved onto the checkout after the session is on
  // screen, and the workspace store following it is the only sign of that the
  // hook gets.
  it('resolves again when the workspace store moves under the open session', async () => {
    mocks.workspacePath = '/tmp/default'
    mocks.resolveSessionWorkspacePath.mockResolvedValue('/tmp/default')
    const { result, rerender } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.path).toBe('/tmp/default'))

    mocks.resolveSessionWorkspacePath.mockResolvedValue('/tmp/app')
    mocks.workspacePath = '/tmp/app'
    rerender()

    await waitFor(() => expect(result.current.path).toBe('/tmp/app'))
  })

  // A folder bound from the files pane can be the one the window already has,
  // so the store never moves and only the rebind says to look again.
  it('resolves again when the seat is rebound without the workspace store moving', async () => {
    mocks.resolveSessionWorkspacePath.mockResolvedValue(null)
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.bindingResolved).toBe(true))
    expect(result.current.boundPath).toBeNull()

    mocks.resolveSessionWorkspacePath.mockResolvedValue('/tmp/a')
    act(() => noteSessionWorkspaceRebound('sess-a'))

    await waitFor(() => expect(result.current.path).toBe('/tmp/a'))
  })

  it('ignores a rebind of another session', async () => {
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.path).toBe('/tmp/a'))
    const calls = mocks.resolveSessionWorkspacePath.mock.calls.length

    act(() => noteSessionWorkspaceRebound('sess-other'))

    expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalledTimes(calls)
  })

  it('marks an empty resolve as unbound rather than pending', async () => {
    mocks.resolveSessionWorkspacePath.mockResolvedValue(null)
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.bindingResolved).toBe(true))
    expect(result.current.boundPath).toBeNull()
    expect(result.current.path).toBeNull()
    expect(result.current.hasLocalAgent).toBe(true)
    expect(result.current.needsWorkspace).toBe(true)
    expect(mocks.localSeatNeedsWorkspace).toHaveBeenCalledWith({
      teamId: 'team-1',
      sessionId: 'sess-a',
      agentId: 'agent-local',
    })
  })

  it('does not ask about the seat when the session resolved to a folder', async () => {
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.path).toBe('/tmp/a'))
    expect(result.current.needsWorkspace).toBe(false)
    expect(mocks.localSeatNeedsWorkspace).not.toHaveBeenCalled()
  })

  // An empty resolve is also what a failed participant read produces. Offering
  // to bind a folder then could overwrite a seat that is bound.
  it('does not report a workspace as needed when the seat could not be confirmed empty', async () => {
    mocks.resolveSessionWorkspacePath.mockResolvedValue(null)
    mocks.localSeatNeedsWorkspace.mockRejectedValue(new Error('502'))
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.bindingResolved).toBe(true))
    expect(result.current.boundPath).toBeNull()
    expect(result.current.needsWorkspace).toBe(false)
  })

  // A resolve that started before the store moved answers for the binding as it
  // was then; joining it left the pane on "Agent 尚未启动" beside the new tree.
  it('does not join a resolve that started before the workspace store moved', async () => {
    let releaseStale: (path: string) => void = () => {}
    mocks.workspacePath = '/tmp/default'
    mocks.resolveSessionWorkspacePath
      .mockImplementationOnce(() => new Promise((resolve) => { releaseStale = resolve }))
      .mockResolvedValue('/tmp/app')
    const { result, rerender } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalledTimes(1))

    mocks.workspacePath = '/tmp/app'
    rerender()
    await waitFor(() => expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.path).toBe('/tmp/app'))

    act(() => releaseStale('/tmp/default'))
    await waitFor(() => expect(result.current.path).toBe('/tmp/app'))
  })

  it('reports no local agent when this machine has none in the session', async () => {
    mocks.participantsBySession = { 'sess-a': [{ actorId: 'agent-remote', displayName: 'Other' }] }
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalled())
    expect(result.current.hasLocalAgent).toBe(false)
    expect(result.current.path).toBeNull()
  })

  // amuxd takes a different actor id under each team. The id seen at mount
  // belongs to the team the app started in; after a switch the session roster
  // names the new one, and a copy held in state hid the tree and terminal for
  // every session until the app was reloaded.
  it('follows the local actor id when the daemon re-inits under another team', async () => {
    noteLocalDaemonActorId('agent-previous-team')
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalled())
    expect(result.current.hasLocalAgent).toBe(false)

    act(() => noteLocalDaemonActorId('agent-local'))

    await waitFor(() => expect(result.current.hasLocalAgent).toBe(true))
    expect(result.current.path).toBe('/tmp/a')
  })

  it('asks the daemon when no local actor id has been observed yet', async () => {
    __resetLocalDaemonIdentityForTest()
    mocks.getLocalDaemonActorId.mockResolvedValue('agent-local')
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.hasLocalAgent).toBe(true))
    expect(mocks.getLocalDaemonActorId).toHaveBeenCalled()
  })

  // Two instances render this hook (app header, files pane) and each resolve is
  // an uncached Cloud round trip.
  it('shares one in-flight resolve across instances', async () => {
    renderHook(() => useSessionLocalWorkspace())
    renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalled())
    expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalledTimes(1)
  })
})
