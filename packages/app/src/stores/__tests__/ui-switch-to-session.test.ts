import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../ui'
import { useSessionSelectionStore } from '../session-selection-store'

// switchToSession reaches into the workspace/tabs stores and resolves the
// session's workspace over daemon IPC + Cloud API. None of that is what these
// tests are about, so stub the collaborators and assert only the sidebar
// behaviour.
vi.mock('@/lib/session/session-by-workspace', () => ({
  switchToSessionWorkspaceIfNeeded: vi.fn(async () => {}),
}))

describe('switchToSession sidebar handling', () => {
  beforeEach(() => {
    useSessionSelectionStore.setState({ activeSessionId: null })
    useUIStore.setState({
      currentView: 'chat',
      sidebarFilter: { kind: 'apps' },
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  it('resets the sidebar to the session list by default', async () => {
    await useUIStore.getState().switchToSession('session-1')
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
  })

  it('leaves the sidebar alone when the caller owns column 2', async () => {
    // Opening an app must not bounce column 2 off the Apps list.
    await useUIStore.getState().switchToSession('session-1', { keepSidebarFilter: true })
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'apps' })
    expect(useUIStore.getState().currentView).toBe('chat')
  })

  it('honours keepSidebarFilter when the session is already active', async () => {
    useSessionSelectionStore.setState({ activeSessionId: 'session-1' })
    useUIStore.setState({ currentView: 'settings' } as Partial<ReturnType<typeof useUIStore.getState>>)
    await useUIStore.getState().switchToSession('session-1', { keepSidebarFilter: true })
    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'apps' })
    expect(useUIStore.getState().currentView).toBe('chat')
  })

  it('closes the automation panel overlay when switching sessions', async () => {
    useUIStore.setState({ automationPanelOpen: true } as Partial<ReturnType<typeof useUIStore.getState>>)
    await useUIStore.getState().switchToSession('session-1')
    expect(useUIStore.getState().automationPanelOpen).toBe(false)
    expect(useUIStore.getState().currentView).toBe('chat')
  })
})
