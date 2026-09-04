import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RuntimeRefreshWorkspaceBanner } from '../RuntimeRefreshBanner'
import { useWorkspaceRuntimeRefreshStore } from '@/stores/workspace-runtime-refresh'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: { kinds?: string }) => {
      const text = fallback ?? key
      if (opts?.kinds) return text.replace('{{kinds}}', opts.kinds)
      return text
    },
    i18n: { language: 'en' },
  }),
}))

describe('RuntimeRefreshWorkspaceBanner', () => {
  beforeEach(() => {
    useWorkspaceRuntimeRefreshStore.getState().stopPolling()
  })

  it('renders nothing when refresh is clean', () => {
    const { container } = render(<RuntimeRefreshWorkspaceBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('does not show the informational pending banner', () => {
    useWorkspaceRuntimeRefreshStore.setState({
      refresh: {
        status: 'pending',
        change_kinds: ['opencode_json'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-06-03T00:00:00Z',
        last_error: null,
      },
    })

    const { container } = render(<RuntimeRefreshWorkspaceBanner />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('runtime-refresh-workspace-banner')).not.toBeInTheDocument()
  })
})
