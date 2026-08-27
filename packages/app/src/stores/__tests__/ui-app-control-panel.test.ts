import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../ui'
import { useWorkspaceStore } from '../workspace'

describe('app control panel vs RightPanel', () => {
  beforeEach(() => {
    useUIStore.setState({
      appControlPanelOpen: false,
    } as Partial<ReturnType<typeof useUIStore.getState>>)
    useWorkspaceStore.setState({
      isPanelOpen: false,
      activeTab: 'shortcuts',
    })
  })

  it('opening app control panel closes the workspace RightPanel', () => {
    useWorkspaceStore.setState({ isPanelOpen: true, activeTab: 'files' })
    useUIStore.getState().openAppControlPanel()
    expect(useUIStore.getState().appControlPanelOpen).toBe(true)
    expect(useWorkspaceStore.getState().isPanelOpen).toBe(false)
  })

  it('opening workspace RightPanel closes the app control panel', async () => {
    useUIStore.setState({ appControlPanelOpen: true })
    useWorkspaceStore.getState().openPanel('diff')
    expect(useWorkspaceStore.getState().isPanelOpen).toBe(true)
    await vi.waitFor(() => {
      expect(useUIStore.getState().appControlPanelOpen).toBe(false)
    })
  })

  it('toggleAppControlPanel closes RightPanel when opening', () => {
    useWorkspaceStore.setState({ isPanelOpen: true })
    useUIStore.getState().toggleAppControlPanel()
    expect(useUIStore.getState().appControlPanelOpen).toBe(true)
    expect(useWorkspaceStore.getState().isPanelOpen).toBe(false)
  })
})
