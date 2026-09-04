import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  currentSessionId: 'sess-a' as string | null,
  teamId: 'team-1' as string | null,
  workspacePath: '/tmp/a' as string | null,
  participantsBySession: {} as Record<string, Array<{ actorId: string; displayName: string }>>,
  ensureParticipants: vi.fn(),
  knownLocalDaemonActorId: 'agent-local' as string | null,
  resolveSessionWorkspacePath: vi.fn(),
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

vi.mock('@/lib/daemon/local-daemon-identity', () => ({
  getKnownLocalDaemonActorId: () => mocks.knownLocalDaemonActorId,
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/session/session-by-workspace', () => ({
  resolveSessionWorkspacePath: (...args: unknown[]) => mocks.resolveSessionWorkspacePath(...args),
}))

import { useSessionLocalWorkspace } from '../use-session-local-workspace'

describe('useSessionLocalWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.currentSessionId = 'sess-a'
    mocks.teamId = 'team-1'
    mocks.workspacePath = '/tmp/a'
    mocks.knownLocalDaemonActorId = 'agent-local'
    mocks.participantsBySession = {
      'sess-a': [{ actorId: 'agent-local', displayName: 'Mac-mini-3' }],
      'sess-b': [{ actorId: 'agent-local', displayName: 'Mac-mini-3' }],
    }
    mocks.resolveSessionWorkspacePath.mockImplementation(async (_team: string, id: string) =>
      id === 'sess-a' ? '/tmp/a' : '/tmp/b',
    )
  })

  it('reports the session folder once the workspace store agrees', async () => {
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(result.current.path).toBe('/tmp/a'))
    expect(result.current.hasLocalAgent).toBe(true)
    expect(result.current.agentName).toBe('Mac-mini-3')
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
    expect(result.current.path).toBeNull()
    expect(result.current.hasLocalAgent).toBe(true)

    mocks.workspacePath = '/tmp/b'
    rerender()
    await waitFor(() => expect(result.current.path).toBe('/tmp/b'))
  })

  it('reports no local agent when this machine has none in the session', async () => {
    mocks.participantsBySession = { 'sess-a': [{ actorId: 'agent-remote', displayName: 'Other' }] }
    const { result } = renderHook(() => useSessionLocalWorkspace())
    await waitFor(() => expect(mocks.resolveSessionWorkspacePath).toHaveBeenCalled())
    expect(result.current.hasLocalAgent).toBe(false)
    expect(result.current.path).toBeNull()
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
