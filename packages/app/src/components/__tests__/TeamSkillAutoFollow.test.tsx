import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { CloudApiError } from '@/lib/backend/cloud-api/http'

const toastError = vi.fn()
const reconcile = vi.fn()

vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), info: vi.fn() } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}))
vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/stores/team-share-browser', () => ({
  useTeamShareBrowserStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      reconcileSkills: reconcile,
      skillRetired: {},
      dismissRetired: vi.fn(),
    }),
}))

import { TeamSkillAutoFollow } from '../TeamSkillAutoFollow'

describe('TeamSkillAutoFollow', () => {
  beforeEach(() => {
    toastError.mockReset()
    reconcile.mockReset()
    reconcile.mockResolvedValue(undefined)
  })

  it('toasts an expired session instead of swallowing 401', async () => {
    reconcile.mockRejectedValue(new CloudApiError(401, 'missing_auth', 'expired', null))
    render(<TeamSkillAutoFollow teamId="team-1" />)
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(String(toastError.mock.calls[0][0])).toMatch(/登录已过期/)
  })

  it('does not toast ordinary reconcile failures', async () => {
    reconcile.mockRejectedValue(new Error('network down'))
    render(<TeamSkillAutoFollow teamId="team-1" />)
    await waitFor(() => {
      expect(reconcile).toHaveBeenCalled()
    })
    expect(toastError).not.toHaveBeenCalled()
  })
})
