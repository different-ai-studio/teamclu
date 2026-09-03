import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NarrowChatHeader } from '@/components/responsive/NarrowChatHeader'
import { useUIStore } from '@/stores/ui'
import { useSessionSelectionStore } from '@/stores/session-selection-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}))

vi.mock('@/components/ui/traffic-lights', () => ({
  TrafficLights: () => null,
}))

vi.mock('@/components/sidebar/SessionListColumn', () => ({
  SessionListColumn: () => <div data-testid="session-list-column" />,
}))

vi.mock('@/lib/config/platform', () => ({
  capabilities: { pageCapture: true },
}))

vi.mock('@/lib/config/build-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/build-config')>()
  return {
    ...actual,
    hideExtensionSettingsButton: false,
  }
})

const createQuickSession = vi.fn()
vi.mock('@/lib/session/create-quick-session', () => ({
  createQuickSession: (...args: unknown[]) => createQuickSession(...args),
  describeQuickSessionFailure: () => ({ title: 'fail', description: 'desc' }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

describe('NarrowChatHeader', () => {
  beforeEach(() => {
    useUIStore.setState({ embedMode: true, currentView: 'chat' })
    useSessionSelectionStore.setState({ activeSessionId: null })
    createQuickSession.mockReset()
    createQuickSession.mockResolvedValue({ ok: true, agentDisplayName: 'MACPRO' })
  })

  it('hides the new chat button on the welcome page', () => {
    render(<NarrowChatHeader />)
    expect(screen.queryByRole('button', { name: 'New Chat' })).not.toBeInTheDocument()
  })

  it('shows the new chat button when a session is active', () => {
    useSessionSelectionStore.setState({ activeSessionId: 'sess-1' })
    render(<NarrowChatHeader />)
    expect(screen.getByRole('button', { name: 'New Chat' })).toBeInTheDocument()
  })

  it('creates a session directly when the header new chat button is clicked', async () => {
    useSessionSelectionStore.setState({ activeSessionId: 'sess-1' })
    render(<NarrowChatHeader />)

    screen.getByRole('button', { name: 'New Chat' }).click()

    await vi.waitFor(() => {
      expect(createQuickSession).toHaveBeenCalledTimes(1)
    })
  })
})
