import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// ── hoisted mocks ────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string) => d ?? _k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}))

vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="setting-card">{children}</div>
  ),
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => (
    <input type="checkbox" checked={enabled} readOnly />
  ),
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('@/lib/daemon/amuxd-channels', async () => {
  const actual = await vi.importActual<typeof import('@/lib/daemon/amuxd-channels')>(
    '@/lib/daemon/amuxd-channels',
  )
  return {
    ...actual,
    listChannels: vi.fn(),
  }
})

// ── imports after mocks ──────────────────────────────────────────────────────

import * as api from '@/lib/daemon/amuxd-channels'
import { GatewayStatusCard } from '../GatewayStatusCard'

// ── shared props ─────────────────────────────────────────────────────────────

const noop = () => {}

const baseProps = {
  icon: <span data-testid="icon" />,
  title: 'Discord Gateway',
  status: 'disconnected' as const,
  expanded: false,
  onToggleExpanded: noop,
  enabled: false,
  onToggleEnabled: noop,
  isLoading: false,
  isConnecting: false,
  isRunning: false,
  hasChanges: false,
  onStartStop: noop,
  onRestart: noop,
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('GatewayStatusCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("does not show the global 'amuxd not running' banner inside a card", () => {
    vi.mocked(api.listChannels).mockRejectedValue(new api.AmuxdUnreachableError())
    render(<GatewayStatusCard {...baseProps} />)
    expect(screen.queryByText(/amuxd not running/i)).toBeNull()
    expect(api.listChannels).not.toHaveBeenCalled()
  })

  it('renders the gateway title without probing amuxd', () => {
    vi.mocked(api.listChannels).mockResolvedValue([
      { platform: 'discord', enabled: true, connected: false, lastError: null },
    ])
    render(<GatewayStatusCard {...baseProps} title="Discord Gateway" />)
    expect(screen.getByText('Discord Gateway')).toBeTruthy()
    expect(screen.queryByText(/amuxd not running/i)).toBeNull()
    expect(api.listChannels).not.toHaveBeenCalled()
  })
})
