import { describe, expect, it } from 'vitest'

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
