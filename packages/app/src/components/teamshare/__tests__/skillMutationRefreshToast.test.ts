import { describe, expect, test, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { SkillMutationRefreshError } from '@/stores/team-share-browser'
import { toastSkillMutationRefreshFailed } from '../skillMutationRefreshToast'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

describe('toastSkillMutationRefreshFailed', () => {
  const t = (key: string, fallback: string) => fallback
  const retry = vi.fn(async () => {})

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('install refresh failure does not say install failed', () => {
    toastSkillMutationRefreshFailed(
      t,
      new SkillMutationRefreshError('install', 'say-hello'),
      retry,
    )
    expect(toast.error).toHaveBeenCalledTimes(1)
    const [message, opts] = vi.mocked(toast.error).mock.calls[0]
    expect(String(message).toLowerCase()).not.toContain('install failed')
    expect(String(message)).toMatch(/installed/i)
    expect(opts).toEqual(
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Retry refresh' }),
      }),
    )
  })

  test('uninstall refresh failure does not say uninstall failed', () => {
    toastSkillMutationRefreshFailed(
      t,
      new SkillMutationRefreshError('uninstall', 'say-hello'),
      retry,
    )
    const [message] = vi.mocked(toast.error).mock.calls[0]
    expect(String(message).toLowerCase()).not.toContain('uninstall failed')
    expect(String(message)).toMatch(/uninstalled/i)
  })

  test('delete refresh failure does not ask the user to delete again', () => {
    toastSkillMutationRefreshFailed(
      t,
      new SkillMutationRefreshError('delete-team', 'say-hello'),
      retry,
    )
    const [message, opts] = vi.mocked(toast.error).mock.calls[0]
    expect(String(message).toLowerCase()).not.toContain('delete failed')
    expect(String(message).toLowerCase()).not.toContain('remove failed')
    expect(opts?.action?.label).toBe('Retry refresh')
  })

  test('retry action only invokes the refresh callback', async () => {
    toastSkillMutationRefreshFailed(
      t,
      new SkillMutationRefreshError('install', 'say-hello'),
      retry,
    )
    const opts = vi.mocked(toast.error).mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    opts.action.onClick()
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
  })
})
