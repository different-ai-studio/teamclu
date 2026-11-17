import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileMentionPopover, invalidateFileMentionCache } from '../FileMentionPopover'

const { mockReadDir } = vi.hoisted(() => ({
  mockReadDir: vi.fn(),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    isTauri: () => true,
  }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: { workspacePath: string }) => unknown) =>
    selector({ workspacePath: '/workspace/project' }),
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: {
    getState: () => ({ devUnlocked: false }),
  },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: mockReadDir,
}))

describe('FileMentionPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateFileMentionCache()
    mockReadDir.mockImplementation(async (dir: string) => {
      if (dir === '/workspace/project') {
        return [
          { name: 'README.md', isDirectory: false },
          { name: 'src', isDirectory: true },
        ]
      }
      return []
    })
  })

  it('selects the highlighted file with Tab', async () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <FileMentionPopover
        open={true}
        onOpenChange={onOpenChange}
        searchQuery="read"
        onSearchChange={vi.fn()}
        onSelect={onSelect}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeTruthy()
    })

    // The keydown handler reads filteredEntriesRef.current, which is synced
    // from filteredEntries in a separate effect that may commit one tick after
    // the list first renders. Re-fire Tab until that ref is populated so the
    // test does not race the ref sync (flaky under CI load, never hit by a
    // real user).
    await waitFor(() => {
      fireEvent.keyDown(document, { key: 'Tab' })
      expect(onSelect).toHaveBeenCalledWith('README.md')
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows a file created after the popover was first opened', async () => {
    const props = {
      onOpenChange: vi.fn(),
      searchQuery: '',
      onSearchChange: vi.fn(),
      onSelect: vi.fn(),
    }
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const view = render(<FileMentionPopover open={true} {...props} />)
    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeTruthy()
    })
    view.rerender(<FileMentionPopover open={false} {...props} />)

    // The agent writes a file while the popover is closed; nothing in the UI
    // hears about it.
    mockReadDir.mockImplementation(async (dir: string) =>
      dir === '/workspace/project'
        ? [
            { name: 'README.md', isDirectory: false },
            { name: 'report.md', isDirectory: false },
          ]
        : [],
    )
    now.mockReturnValue(1_000_000 + 60_000)
    view.rerender(<FileMentionPopover open={true} {...props} />)

    await waitFor(() => {
      expect(screen.getByText('report.md')).toBeTruthy()
    })
    now.mockRestore()
  })
})
