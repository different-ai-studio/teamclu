import { beforeEach, describe, expect, it } from 'vitest'
import { useTabsStore } from '../tabs'
import { useUIStore } from '../ui'

describe('enterActorDraft sidebar handling', () => {
  beforeEach(() => {
    useTabsStore.getState().closeAll()
    useUIStore.setState({
      currentView: 'chat',
      sidebarFilter: { kind: 'teamShare', section: 'skills' },
      draftPreselectedActor: null,
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  it('resets teamShare sidebar filter so the chat pane replaces TeamShareDetailPane', () => {
    useUIStore.getState().enterActorDraft({
      id: 'agent-1',
      displayName: 'MACPRO',
      kind: 'agent',
    })

    expect(useUIStore.getState().sidebarFilter).toEqual({ kind: 'all' })
    expect(useUIStore.getState().draftPreselectedActor).toEqual({
      id: 'agent-1',
      displayName: 'MACPRO',
      kind: 'agent',
    })
  })
})
