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

vi.mock('@/components/panel/SessionWorkspacePicker', () => ({
  SessionWorkspacePicker: ({ agentId }: { agentId: string }) =>
    React.createElement('div', { 'data-testid': 'session-workspace-picker', 'data-agent-id': agentId }),
}))

vi.mock('@/components/chat/SessionActorSheet', () => ({
  SessionActorPanel: ({ sessionId, teamId }: { sessionId: string; teamId: string | null }) =>
    React.createElement('div', { 'data-testid': 'session-actor-panel' }, `${sessionId}:${teamId}`),
}))

const mockLocalWorkspace = {
  hasLocalAgent: true,
  agentId: 'agent-local' as string | null,
  agentName: 'Mac-mini-3' as string | null,
  path: '/Volumes/openbeta/workspace/teamclu' as string | null,
  bindingResolved: true,
  boundPath: '/Volumes/openbeta/workspace/teamclu' as string | null,
}
vi.mock('@/hooks/use-session-local-workspace', () => ({
  useSessionLocalWorkspace: () => mockLocalWorkspace,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockStoreState.activeTab = 'shortcuts'
  mockSelection.activeSessionId = null
  mockLocalWorkspace.hasLocalAgent = true
  mockLocalWorkspace.agentId = 'agent-local'
  mockLocalWorkspace.agentName = 'Mac-mini-3'
  mockLocalWorkspace.path = '/Volumes/openbeta/workspace/teamclu'
  mockLocalWorkspace.bindingResolved = true
  mockLocalWorkspace.boundPath = '/Volumes/openbeta/workspace/teamclu'
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

  // A session created a second ago may still be switching the workspace store.
  // Rendering the tree anyway showed the PREVIOUS session's folder.
  it('files tab says the agent has not started while the binding is still pending', () => {
    mockStoreState.activeTab = 'files'
    mockLocalWorkspace.path = null
    mockLocalWorkspace.bindingResolved = false
    mockLocalWorkspace.boundPath = null
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('files-agent-not-started')).toBeDefined()
    expect(screen.getByTestId('files-agent-not-started').textContent).toContain('Agent 尚未启动')
    expect(screen.queryByTestId('file-browser')).toBeNull()
  })

  // workspace_id was never stamped on the participant — not "agent not started".
  it('files tab says the session has no workspace when the binding resolved empty', () => {
    mockStoreState.activeTab = 'files'
    mockLocalWorkspace.path = null
    mockLocalWorkspace.bindingResolved = true
    mockLocalWorkspace.boundPath = null
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('files-no-workspace')).toBeDefined()
    expect(screen.getByTestId('files-no-workspace').textContent).toContain('该会话没有工作目录')
    expect(screen.queryByTestId('files-agent-not-started')).toBeNull()
    expect(screen.queryByTestId('file-browser')).toBeNull()
  })

  // Pulling a local agent into an existing session seats it with no folder, and
  // the only way to give it one used to be leaving the session.
  it('files tab offers to bind a folder for the local agent when the session has none', () => {
    mockStoreState.activeTab = 'files'
    mockLocalWorkspace.path = null
    mockLocalWorkspace.bindingResolved = true
    mockLocalWorkspace.boundPath = null
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('files-no-workspace').textContent).toContain('为 {{agent}} 选择一个工作目录')
    expect(screen.getByTestId('session-workspace-picker').getAttribute('data-agent-id')).toBe('agent-local')
  })

  it('files tab offers no picker while a known binding is still pending', () => {
    mockStoreState.activeTab = 'files'
    mockLocalWorkspace.path = null
    mockLocalWorkspace.bindingResolved = false
    mockLocalWorkspace.boundPath = null
    render(React.createElement(RightPanel))
    expect(screen.queryByTestId('session-workspace-picker')).toBeNull()
  })

  it('files tab still says agent not started while the store has not followed a known binding', () => {
    mockStoreState.activeTab = 'files'
    mockLocalWorkspace.path = null
    mockLocalWorkspace.bindingResolved = true
    mockLocalWorkspace.boundPath = '/tmp/bound'
    render(React.createElement(RightPanel))
    expect(screen.getByTestId('files-agent-not-started')).toBeDefined()
    expect(screen.queryByTestId('files-no-workspace')).toBeNull()
  })

  it('files tab names the agent and its folder under the tree', () => {
    mockStoreState.activeTab = 'files'
    render(React.createElement(RightPanel))
    const footer = screen.getByTestId('files-workspace-footer')
    expect(footer.textContent).toContain('Mac-mini-3')
    expect(footer.getAttribute('title')).toBe('/Volumes/openbeta/workspace/teamclu')
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
