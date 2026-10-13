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

  const failedRefresh = (lastError: string) => ({
    refresh: {
      status: 'failed' as const,
      change_kinds: [],
      recommended_action: 'none' as const,
      auto_apply_blocked_by_active_runtime: false,
      last_detected_at: '2026-06-03T00:00:00Z',
      last_error: lastError,
    },
  })

  it('titles a permission error as an unwritable workspace', () => {
    const error = 'io error: create instructions dir: Permission denied (os error 13)'
    useWorkspaceRuntimeRefreshStore.setState(failedRefresh(error))

    render(<RuntimeRefreshWorkspaceBanner />)
    expect(screen.getByText('Workspace directory is not writable')).toBeInTheDocument()
    expect(screen.getByText(error)).toBeInTheDocument()
  })

  it('keeps the generic title for other failures', () => {
    useWorkspaceRuntimeRefreshStore.setState(failedRefresh('invalid opencode.json: expected value'))

    render(<RuntimeRefreshWorkspaceBanner />)
    expect(screen.getByText('Runtime refresh failed')).toBeInTheDocument()
    expect(screen.queryByText('Workspace directory is not writable')).not.toBeInTheDocument()
  })
})
