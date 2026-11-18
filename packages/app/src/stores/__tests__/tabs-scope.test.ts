import { beforeEach, describe, expect, it } from 'vitest'
import { NO_SESSION_TAB_SCOPE, useTabsStore } from '@/stores/tabs'

function reset() {
  useTabsStore.setState({
    tabs: [],
    activeTabId: null,
    _lastActiveTabId: null,
    scopeKey: NO_SESSION_TAB_SCOPE,
    _parked: {},
  })
}

describe('tabs store — per-session scopes', () => {
  beforeEach(reset)

  it('parks a session’s tabs and brings them back with it', () => {
    const store = useTabsStore.getState()
    store.switchScope('session-a')
    store.openTab({ type: 'file', target: '/a/notes.md', label: 'notes.md' })
    const aTabId = useTabsStore.getState().activeTabId

    useTabsStore.getState().switchScope('session-b')
    expect(useTabsStore.getState().tabs).toEqual([])
    expect(useTabsStore.getState().activeTabId).toBeNull()

    useTabsStore.getState().switchScope('session-a')
    expect(useTabsStore.getState().tabs.map((t) => t.target)).toEqual(['/a/notes.md'])
    expect(useTabsStore.getState().activeTabId).toBe(aTabId)
  })

  it('keeps a hidden column hidden when its session comes back', () => {
    const store = useTabsStore.getState()
    store.switchScope('session-a')
    store.openTab({ type: 'file', target: '/a/notes.md', label: 'notes.md' })
    useTabsStore.getState().hideAll()

    useTabsStore.getState().switchScope('session-b')
    useTabsStore.getState().switchScope('session-a')

    expect(useTabsStore.getState().activeTabId).toBeNull()
    useTabsStore.getState().restoreLastTab()
    expect(useTabsStore.getState().activeTabId).not.toBeNull()
  })

  it('reports parked tabs as still open', () => {
    const store = useTabsStore.getState()
    store.switchScope('session-a')
    store.openTab({ type: 'webview', target: 'https://example.com', label: 'example' })
    const id = useTabsStore.getState().activeTabId!

    useTabsStore.getState().switchScope('session-b')
    expect(useTabsStore.getState().hasTabInAnyScope(id)).toBe(true)
    expect(useTabsStore.getState().hasTabInAnyScope('tab-missing')).toBe(false)
  })

  it('closeWhere reaches parked scopes too', () => {
    const store = useTabsStore.getState()
    store.switchScope('session-a')
    store.openTab({ type: 'native', target: 'team-share:skill/x', label: 'x' })
    store.openTab({ type: 'file', target: '/a/keep.md', label: 'keep.md' })
    useTabsStore.getState().switchScope('session-b')

    useTabsStore.getState().closeWhere((t) => t.target.startsWith('team-share:'))
    useTabsStore.getState().switchScope('session-a')

    expect(useTabsStore.getState().tabs.map((t) => t.target)).toEqual(['/a/keep.md'])
  })

  it('drops an empty scope instead of parking it', () => {
    useTabsStore.getState().switchScope('session-a')
    useTabsStore.getState().switchScope('session-b')
    expect(useTabsStore.getState()._parked).toEqual({})
  })
})
