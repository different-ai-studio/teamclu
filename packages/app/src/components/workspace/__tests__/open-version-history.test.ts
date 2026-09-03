import { describe, test, expect, vi, beforeEach } from 'vitest'

const { openTab, selectFile, loadFileVersions, teamState } = vi.hoisted(() => ({
  openTab: vi.fn(),
  selectFile: vi.fn(),
  loadFileVersions: vi.fn(async () => undefined),
  teamState: { team: { id: 'team-1' } as { id: string } | null },
}))

vi.mock('@/stores/tabs', () => ({ useTabsStore: { getState: () => ({ openTab }) } }))
vi.mock('@/stores/current-team', () => ({ useCurrentTeamStore: { getState: () => teamState } }))
vi.mock('@/stores/version-history', () => ({
  useVersionHistoryStore: { getState: () => ({ selectFile, loadFileVersions }) },
}))
// The helper is a leaf inside a component file; the rest of that file drags in
// the whole tree UI, which this has nothing to do with.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d }) }))
vi.mock('@/lib/team/team-permissions', () => ({ useTeamPermissions: () => ({}) }))

import { openVersionHistory } from '../FileTreeNode'

describe('openVersionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    teamState.team = { id: 'team-1' }
  })

  test('the file is part of the tab address', () => {
    // Not shared store state: two files' histories can be open at once, and
    // neither depends on what happens to be selected elsewhere.
    openVersionHistory('/team/knowledge/spec.md', 'Version history')

    expect(openTab).toHaveBeenCalledWith({
      type: 'native',
      target: 'version-history//team/knowledge/spec.md',
      label: 'Version history',
    })
  })

  test('preloads the file so the view has data before its own effect runs', () => {
    openVersionHistory('/ws/docs/spec.md', 'Version history')

    expect(selectFile).toHaveBeenCalledWith('/ws/docs/spec.md')
    expect(loadFileVersions).toHaveBeenCalledWith('team-1', '/ws/docs/spec.md')
  })

  test('still opens with no current team', () => {
    teamState.team = null

    openVersionHistory('/ws/docs/spec.md', 'Version history')

    expect(openTab).toHaveBeenCalled()
    expect(loadFileVersions).not.toHaveBeenCalled()
  })
})
