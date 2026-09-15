import { describe, expect, it } from 'vitest'
import {
  CURRENT_WINDOW_WORKSPACE_ID,
  pickNewSessionWorkspaceId,
} from '../new-session-workspace'

const workspaces = [
  { id: 'ws-other', path: '/tmp/other' },
  { id: 'ws-default', path: '/tmp/teamclu' },
]

describe('pickNewSessionWorkspaceId', () => {
  it('keeps a still-valid registered selection', () => {
    expect(
      pickNewSessionWorkspaceId({
        currentId: 'ws-other',
        workspaces,
        windowPath: '/Users/me/Copilot 361',
        defaultWorkspaceId: 'ws-default',
      }),
    ).toBe('ws-other')
  })

  it('prefers the current window folder when it is already registered', () => {
    expect(
      pickNewSessionWorkspaceId({
        currentId: '',
        workspaces: [...workspaces, { id: 'ws-copilot', path: '/Users/me/Copilot 361' }],
        windowPath: '/Users/me/Copilot 361',
        defaultWorkspaceId: 'ws-default',
      }),
    ).toBe('ws-copilot')
  })

  it('uses the current-window sentinel when the folder is not in the list', () => {
    expect(
      pickNewSessionWorkspaceId({
        currentId: '',
        workspaces,
        windowPath: '/Users/me/Copilot 361',
        defaultWorkspaceId: 'ws-default',
      }),
    ).toBe(CURRENT_WINDOW_WORKSPACE_ID)
  })

  it('falls back to the agent default only when there is no window folder', () => {
    expect(
      pickNewSessionWorkspaceId({
        currentId: '',
        workspaces,
        windowPath: '',
        defaultWorkspaceId: 'ws-default',
      }),
    ).toBe('ws-default')
  })

  it('upgrades the current-window sentinel to the registered row once it appears', () => {
    expect(
      pickNewSessionWorkspaceId({
        currentId: CURRENT_WINDOW_WORKSPACE_ID,
        workspaces: [...workspaces, { id: 'ws-copilot', path: '/Users/me/Copilot 361' }],
        windowPath: '/Users/me/Copilot 361',
        defaultWorkspaceId: 'ws-default',
      }),
    ).toBe('ws-copilot')
  })

  it('does not silently pick the first listed workspace', () => {
    expect(
      pickNewSessionWorkspaceId({
        currentId: '',
        workspaces,
        windowPath: '',
        defaultWorkspaceId: 'ws-missing',
      }),
    ).toBe('')
  })
})
