import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  listen: vi.fn(),
  unlisten: vi.fn(),
  load: vi.fn(async () => {}),
  refreshLocalApps: vi.fn(async () => {}),
  invalidateAppSummary: vi.fn(),
  apps: { teamId: null as string | null },
  currentTeam: { team: null as { id: string } | null },
}))

vi.mock('@/lib/utils', () => ({ isTauri: mocks.isTauri }))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: {
    getState: () => ({
      teamId: mocks.apps.teamId,
      load: mocks.load,
      refreshLocalApps: mocks.refreshLocalApps,
      invalidateAppSummary: mocks.invalidateAppSummary,
    }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => mocks.currentTeam },
}))

import {
  AGENT_APP_CHANGED_EVENT,
  AGENT_APP_CHANGE_DEBOUNCE_MS,
  createTrailingBatcher,
  teamToReloadAfterAgentChanges,
  useAgentAppChanges,
} from '../use-agent-app-changes'

type Handler = (event: { payload: unknown }) => void

/** Mount the hook and wait until it is listening; returns the event handler. */
async function mountListening() {
  let handler: Handler | null = null
  mocks.listen.mockImplementation(async (_name: string, h: Handler) => {
    handler = h
    return mocks.unlisten
  })
  const view = renderHook(() => useAgentAppChanges())
  await waitFor(() => expect(handler).not.toBeNull())
  return { ...view, emit: (payload: unknown) => handler!({ payload }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isTauri.mockReturnValue(true)
  mocks.apps.teamId = 'team-1'
  mocks.currentTeam.team = { id: 'team-1' }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('teamToReloadAfterAgentChanges', () => {
  it('re-reads the team on screen when a change names it', () => {
    expect(teamToReloadAfterAgentChanges(['team-1'], 'team-1')).toBe('team-1')
  })

  it('reads a change that names no team as the team on screen', () => {
    expect(teamToReloadAfterAgentChanges([null], 'team-1')).toBe('team-1')
  })

  it('leaves another team\'s change alone rather than swapping its apps in', () => {
    // The store holds one team's list; loading team-2 would put team-2's apps
    // in the sidebar under team-1.
    expect(teamToReloadAfterAgentChanges(['team-2'], 'team-1')).toBeNull()
    expect(teamToReloadAfterAgentChanges(['team-2', 'team-1'], 'team-1')).toBe('team-1')
  })

  it('with nothing on screen, lets the latest named change decide', () => {
    expect(teamToReloadAfterAgentChanges(['team-2', 'team-3', null], null)).toBe('team-3')
    expect(teamToReloadAfterAgentChanges([null, undefined], null)).toBeNull()
  })
})

describe('createTrailingBatcher', () => {
  it('hands a burst over once, after it goes quiet', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const batcher = createTrailingBatcher<number>(300, flush)

    batcher.push(1)
    vi.advanceTimersByTime(200)
    batcher.push(2)
    vi.advanceTimersByTime(200)
    batcher.push(3)
    vi.advanceTimersByTime(299)
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([1, 2, 3])

    batcher.push(4)
    vi.advanceTimersByTime(300)
    expect(flush).toHaveBeenLastCalledWith([4])
  })

  it('drops what is waiting when cancelled', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const batcher = createTrailingBatcher<number>(300, flush)
    batcher.push(1)
    batcher.cancel()
    vi.advanceTimersByTime(1000)
    expect(flush).not.toHaveBeenCalled()
  })
})

describe('useAgentAppChanges', () => {
  it('does nothing outside the desktop app', async () => {
    mocks.isTauri.mockReturnValue(false)
    renderHook(() => useAgentAppChanges())
    await Promise.resolve()
    expect(mocks.listen).not.toHaveBeenCalled()
  })

  it('turns a burst of agent changes into one forced re-read', async () => {
    const { emit } = await mountListening()
    expect(mocks.listen).toHaveBeenCalledWith(AGENT_APP_CHANGED_EVENT, expect.any(Function))

    vi.useFakeTimers()
    emit({ teamId: 'team-1', appId: 'app-1' })
    emit({ teamId: 'team-1', appId: 'app-1' })
    emit({ teamId: 'team-1', appId: 'app-2' })
    vi.advanceTimersByTime(AGENT_APP_CHANGE_DEBOUNCE_MS - 1)
    expect(mocks.load).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    await waitFor(() => expect(mocks.invalidateAppSummary).toHaveBeenCalledTimes(1))
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(mocks.load).toHaveBeenCalledWith('team-1', { force: true })
    expect(mocks.refreshLocalApps).toHaveBeenCalledTimes(1)
    expect(mocks.refreshLocalApps).toHaveBeenCalledWith('team-1')
  })

  it('falls back to the store\'s team when the event and current team name none', async () => {
    mocks.currentTeam.team = null
    mocks.apps.teamId = 'team-9'
    const { emit } = await mountListening()

    emit({ teamId: null, appId: null })
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith('team-9', { force: true }))
    expect(mocks.refreshLocalApps).toHaveBeenCalledWith('team-9')
  })

  it('still recounts the panel when the list re-read fails', async () => {
    mocks.refreshLocalApps.mockRejectedValueOnce(new Error('daemon down'))
    const { emit } = await mountListening()

    emit({ teamId: 'team-1', appId: 'app-1' })
    await waitFor(() => expect(mocks.invalidateAppSummary).toHaveBeenCalledTimes(1))
  })

  it('stops listening on unmount and drops a batch still waiting', async () => {
    const { emit, unmount } = await mountListening()

    vi.useFakeTimers()
    emit({ teamId: 'team-1', appId: 'app-1' })
    unmount()
    vi.advanceTimersByTime(AGENT_APP_CHANGE_DEBOUNCE_MS * 2)

    expect(mocks.unlisten).toHaveBeenCalledTimes(1)
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.invalidateAppSummary).not.toHaveBeenCalled()
  })

  it('releases a listener that finished registering after unmount', async () => {
    let resolveListen: (off: () => void) => void = () => {}
    mocks.listen.mockImplementation(
      () => new Promise<() => void>((resolve) => { resolveListen = resolve }),
    )
    const { unmount } = renderHook(() => useAgentAppChanges())
    await waitFor(() => expect(mocks.listen).toHaveBeenCalled())

    unmount()
    resolveListen(mocks.unlisten)
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledTimes(1))
  })
})
