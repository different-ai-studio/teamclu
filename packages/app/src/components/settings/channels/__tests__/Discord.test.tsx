import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))

const mockStore = {
  discord: { token: '', enabled: false, guilds: {}, dm: { enabled: false, policy: 'open', allowFrom: [] } },
  isLoading: false,
  gatewayStatus: { status: 'disconnected', connectedGuilds: [], botUsername: '', errorMessage: '' },
  hasChanges: false,
  isTesting: false,
  testResult: null,
  saveDiscordConfig: vi.fn(),
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
  refreshStatus: vi.fn(),
  testToken: vi.fn(),
  clearTestResult: vi.fn(),
  setHasChanges: vi.fn(),
  toggleDiscordEnabled: vi.fn(),
}

vi.mock('@/stores/channels-store', () => ({
  useChannelsStore: vi.fn(() => mockStore),
  defaultDiscordConfig: { token: '', enabled: false, guilds: {}, dm: { enabled: false, policy: 'open', allowFrom: [] } },
}))
vi.mock('../shared', () => ({
  DiscordIcon: () => <span data-testid="discord-icon" />,
  SettingCard: ({ children }: { children: React.ReactNode }) => <div data-testid="setting-card">{children}</div>,
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}))
vi.mock('../DiscordDialogs', () => ({
  SetupWizard: () => null,
  ChannelConfigDialog: () => null,
  GuildConfigDialog: () => null,
  DeleteGuildDialog: () => null,
  DeleteChannelDialog: () => null,
  X: () => null,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))

import { DiscordChannel } from '../Discord'

describe('DiscordChannel', () => {
  it('renders the Discord Gateway header', () => {
    render(<DiscordChannel />)
    expect(screen.getByText('Discord Gateway')).toBeTruthy()
  })

  it('shows disconnected status', () => {
    render(<DiscordChannel />)
    expect(screen.getByText('disconnected')).toBeTruthy()
  })
})
