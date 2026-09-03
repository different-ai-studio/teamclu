import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { RightPanel } from '@/components/panel/RightPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// Mutable so tests can change the store's activeTab
const mockStoreState = { activeTab: 'shortcuts' as string }

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}))

const mockSelection = { activeSessionId: null as string | null }
vi.mock('@/stores/session-selection-store', () => ({
  useSessionSelectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockSelection),
}))

vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ rows: [{ id: 'sess-1', team_id: 'team-from-row' }] }),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ team: { id: 'team-current' } }),
}))

vi.mock('@/components/workspace/FileBrowser', () => ({
  FileBrowser: ({ variant }: { variant?: string }) =>
    React.createElement('div', { 'data-testid': 'file-browser', 'data-variant': variant }),
}))

vi.mock('@/components/panel/ShortcutsPanel', () => ({
  ShortcutsPanel: () => React.createElement('div', { 'data-testid': 'shortcuts-panel' }),
}))

vi.mock('@/components/panel/ActorsView', () => ({
  ActorsView: () => React.createElement('div', { 'data-testid': 'actors-view' }),
}))

vi.mock('@/components/chat/SessionActorSheet', () => ({
  SessionActorPanel: ({ sessionId, teamId }: { sessionId: string; teamId: string | null }) =>
    React.createElement('div', { 'data-testid': 'session-actor-panel' }, `${sessionId}:${teamId}`),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState.activeTab = 'shortcuts'
  mockSelection.activeSessionId = null
})

describe('RightPanel', () => {
  it('renders the shortcuts tab from the store', () => {
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('shortcuts-panel')).toBeDefined()
    expect(screen.queryByTestId('file-browser')).toBeNull()
  })

  it('renders the files tab as a panel-variant FileBrowser', () => {
    mockStoreState.activeTab = 'files'
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('file-browser').getAttribute('data-variant')).toBe('panel')
    expect(screen.queryByTestId('shortcuts-panel')).toBeNull()
  })

  it('defaultTab overrides the store tab', () => {
    mockStoreState.activeTab = 'shortcuts'
    render(React.createElement(RightPanel, { defaultTab: 'files' }))
    expect(screen.getByTestId('file-browser')).toBeDefined()
    expect(screen.queryByTestId('shortcuts-panel')).toBeNull()
  })

  it('actors tab shows the team actors view without an active session', () => {
    mockStoreState.activeTab = 'actors'
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('actors-view')).toBeDefined()
  })

  it('actors tab shows the session actor panel with the session row team', () => {
    mockStoreState.activeTab = 'actors'
    mockSelection.activeSessionId = 'sess-1'
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('session-actor-panel').textContent).toBe('sess-1:team-from-row')
  })

  it('compact mode tightens padding; actors tab drops it', () => {
    const { container: compactEl } = render(React.createElement(RightPanel, { compact: true }))
    const { container: normalEl } = render(React.createElement(RightPanel, { compact: false }))
    expect(compactEl.firstElementChild?.className).toContain('p-1')
    expect(normalEl.firstElementChild?.className).toContain('p-2')

    mockStoreState.activeTab = 'actors'
    const { container } = render(React.createElement(RightPanel))
    const className = container.firstElementChild?.className || ''
    expect(className).not.toContain('p-1')
    expect(className).not.toContain('p-2')
  })
})
