import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const mockLoadJobs = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}))

vi.mock('@/stores/cron', () => ({
  useCronStore: () => ({
    jobs: [],
    isLoading: false,
    error: null,
    loadJobs: mockLoadJobs,
    removeJob: vi.fn(),
    toggleEnabled: vi.fn(),
    runJob: vi.fn(),
    clearError: vi.fn(),
  }),
  formatSchedule: () => 'Cron: 0 9 * * *',
  formatRelativeTime: () => 'soon',
  getChannelDisplayName: (channel: string) => channel,
}))

vi.mock('@/lib/cron/cron-utils', () => ({
  getDeliveryTargetDisplay: () => 'target',
}))

vi.mock('@/lib/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))

vi.mock('../shared', () => ({
  ToggleSwitch: ({ enabled, onChange }: any) => (
    <input
      type="checkbox"
      checked={enabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
      readOnly
    />
  ),
}))

vi.mock('../cron/CronJobDialog', () => ({
  CronJobDialog: () => null,
}))

vi.mock('../cron/CronHistoryDialog', () => ({
  CronHistoryDialog: () => null,
}))

import { CronSection } from '../CronSection'

describe('CronSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads jobs immediately when mounted', async () => {
    render(<CronSection />)

    await waitFor(() => {
      expect(mockLoadJobs).toHaveBeenCalledTimes(1)
    })
  })
})
