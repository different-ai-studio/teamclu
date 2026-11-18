import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionSelectionStore } from '../session-selection-store'
import { useTabsStore } from '../tabs'
import { useTeamShareBrowserStore } from '../team-share-browser'
import { useUIStore } from '../ui'
import { useWorkspaceStore } from '../workspace'

describe('startNewChat detail cleanup', () => {
  beforeEach(() => {
    useTabsStore.getState().closeAll()
    useTeamShareBrowserStore.getState().clearDetail()
    useSessionSelectionStore.getState().clearActiveSession()
    useWorkspaceStore.setState({
      selectedFile: null,
      selectedFiles: [],
      fileContent: null,
    })
    useUIStore.setState({
      currentView: 'chat',
      contentColumnMode: 'full',
      sidebarFilter: { kind: 'teamShare', section: 'knowledge' },
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  it('leaves a knowledge detail and enters the draft session in split layout', async () => {
    useTabsStore.getState().openTab({
      type: 'file',
      target: '/workspace/teamclu-team/knowledge/spec.md',
      label: 'spec.md',
    })
    useWorkspaceStore.setState({
      selectedFile: '/workspace/teamclu-team/knowledge/spec.md',
      selectedFiles: ['/workspace/teamclu-team/knowledge/spec.md'],
      fileContent: '# Spec',
    })
    useTeamShareBrowserStore.getState().select('mcp', 'memory')
    useSessionSelectionStore.setState({
      activeSessionId: 'session-1',
      currentSessionId: 'session-1',
    })

    useUIStore.getState().startNewChat()

    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
    await vi.waitFor(() => {
      expect(useTabsStore.getState().getActiveTab()).toBeNull()
      expect(useWorkspaceStore.getState().selectedFile).toBeNull()
      expect(useTeamShareBrowserStore.getState().detailTarget).toBeNull()
      expect(useSessionSelectionStore.getState().activeSessionId).toBeNull()
    })
  })
})
