import { describe, expect, it, vi } from 'vitest'

import { SKILLS_CHANGED_EVENT } from '@/hooks/useAppInit'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

import { shouldReloadPickerFromDaemonRefresh } from '../command-popover-skills-refresh'

describe('shouldReloadPickerFromDaemonRefresh', () => {
  it('reloads once per daemon skills detection timestamp', () => {
    const first = shouldReloadPickerFromDaemonRefresh(
      {
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-08-28T06:00:00Z',
        last_error: null,
      },
      null,
    )
    expect(first.reload).toBe(true)
    expect(first.nextHandledAt).toBe('2026-08-28T06:00:00Z')

    const second = shouldReloadPickerFromDaemonRefresh(
      {
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-08-28T06:00:00Z',
        last_error: null,
      },
      first.nextHandledAt,
    )
    expect(second.reload).toBe(false)
  })

  it('does not reload for non-skills refresh kinds', () => {
    const result = shouldReloadPickerFromDaemonRefresh(
      {
        status: 'pending',
        change_kinds: ['mcp'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-08-28T06:00:00Z',
        last_error: null,
      },
      null,
    )
    expect(result.reload).toBe(false)
  })
})

describe('CommandPopover daemon refresh loop guard', () => {
  it('does not call noteLocalRefresh when only bumping picker revision from daemon state', () => {
    const noteLocalRefresh = vi.fn()
    useWorkspaceRuntimeRefreshStore.setState({
      refresh: {
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-08-28T06:01:00Z',
        last_error: null,
      },
    })

    const bump = () => {
      const refresh = useWorkspaceRuntimeRefreshStore.getState().refresh
      const handledAt = shouldReloadPickerFromDaemonRefresh(refresh, null)
      expect(handledAt.reload).toBe(true)
    }

    bump()
    expect(noteLocalRefresh).not.toHaveBeenCalled()
  })

  it('still allows filesystem-origin events to request noteLocalRefresh', () => {
    const noteLocalRefresh = vi.fn()
    const onFilesystemChange = () => noteLocalRefresh(['skills'])
    window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT))
    onFilesystemChange()
    expect(noteLocalRefresh).toHaveBeenCalledWith(['skills'])
  })
})
