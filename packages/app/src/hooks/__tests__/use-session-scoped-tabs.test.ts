import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSessionScopedTabs } from '@/hooks/use-session-scoped-tabs'
import { NO_SESSION_TAB_SCOPE, useTabsStore } from '@/stores/tabs'
import { useSessionStore } from '@/stores/session-store'
import { useUIStore, type SidebarFilter } from '@/stores/ui'

const KNOWLEDGE: SidebarFilter = { kind: 'teamShare', section: 'knowledge' }

function openDoc(target: string) {
  act(() => {
    useTabsStore.getState().openTab({ type: 'file', target, label: target })
  })
}

function navigate(filter: SidebarFilter) {
  act(() => {
    useUIStore.getState().setSidebarFilter(filter)
  })
}

function openSession(id: string | null) {
  act(() => {
    useSessionStore.setState({ activeSessionId: id } as Partial<ReturnType<typeof useSessionStore.getState>>)
  })
}

describe('useSessionScopedTabs', () => {
  beforeEach(() => {
    useTabsStore.setState({
      tabs: [],
      activeTabId: null,
      _lastActiveTabId: null,
      scopeKey: NO_SESSION_TAB_SCOPE,
      _parked: {},
    })
    useSessionStore.setState({ activeSessionId: 'session-1' } as Partial<ReturnType<typeof useSessionStore.getState>>)
    useUIStore.setState({ sidebarFilter: { kind: 'all' } } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  it.each<SidebarFilter>([
    { kind: 'all' },
    { kind: 'actors' },
    { kind: 'ideas' },
    { kind: 'teamShare', section: 'skills' },
  ])('parks knowledge documents when navigating to $kind, and brings them back', (destination) => {
    renderHook(() => useSessionScopedTabs())
    navigate(KNOWLEDGE)
    openDoc('/knowledge/spec.md')
    const docTab = useTabsStore.getState().activeTabId

    navigate(destination)
    expect(useTabsStore.getState().activeTabId).toBeNull()

    navigate(KNOWLEDGE)
    expect(useTabsStore.getState().activeTabId).toBe(docTab)
  })

  it('keeps a session’s files apart from knowledge documents', () => {
    renderHook(() => useSessionScopedTabs())
    openDoc('/workspace/notes.md')
    navigate(KNOWLEDGE)
    expect(useTabsStore.getState().tabs).toEqual([])
    openDoc('/knowledge/spec.md')

    navigate({ kind: 'all' })
    expect(useTabsStore.getState().tabs.map((t) => t.target)).toEqual(['/workspace/notes.md'])
  })

  it('gives each session its own tabs', () => {
    renderHook(() => useSessionScopedTabs())
    openDoc('/workspace/a.md')

    openSession('session-2')
    expect(useTabsStore.getState().tabs).toEqual([])

    openSession('session-1')
    expect(useTabsStore.getState().tabs.map((t) => t.target)).toEqual(['/workspace/a.md'])
  })

  it('uses its own scope while no session is open', () => {
    renderHook(() => useSessionScopedTabs())
    openSession(null)
    expect(useTabsStore.getState().scopeKey).toBe(NO_SESSION_TAB_SCOPE)
  })
})
