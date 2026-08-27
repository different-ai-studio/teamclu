import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('shows informational pending banner without apply action', async () => {
    const dismissBanner = vi.fn()
    useWorkspaceRuntimeRefreshStore.setState({
      refresh: {
        status: 'pending',
        change_kinds: ['skills', 'mcp'],
        recommended_action: 'none',
        auto_apply_blocked_by_active_runtime: false,
        last_detected_at: '2026-06-03T00:00:00Z',
        last_error: null,
      },
      dismissBanner,
    })

    render(<RuntimeRefreshWorkspaceBanner />)

    expect(screen.getByTestId('runtime-refresh-workspace-banner')).toBeInTheDocument()
    expect(screen.getByText(/Updated: skills, MCP/i)).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-refresh-apply')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-refresh-dismiss'))
    expect(dismissBanner).toHaveBeenCalled()
  })
})
