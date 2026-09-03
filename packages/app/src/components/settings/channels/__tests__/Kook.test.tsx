import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))

const mockStore = {
  kook: { token: '', enabled: false, guilds: {}, dm: { enabled: false, policy: 'open', allowFrom: [] } },
  kookIsLoading: false,
  kookGatewayStatus: { status: 'disconnected', botUsername: '', errorMessage: '' },
  kookHasChanges: false,
  kookIsTesting: false,
  kookTestResult: null,
  saveKookConfig: vi.fn(), startKookGateway: vi.fn(), stopKookGateway: vi.fn(),
  testKookToken: vi.fn(), clearKookTestResult: vi.fn(), setKookHasChanges: vi.fn(),
}

vi.mock('@/stores/channels-store', () => ({
  useChannelsStore: vi.fn(() => mockStore),
  defaultKookConfig: { token: '', enabled: false, guilds: {}, dm: { enabled: false, policy: 'open', allowFrom: [] } },
}))
vi.mock('../shared', () => ({
  KookIcon: () => <span data-testid="kook-icon" />,
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}))
vi.mock('../KookDialogs', () => ({
  KookSetupWizard: () => null,
  KookGuildConfigDialog: () => null,
  KookChannelConfigDialog: () => null,
  KookDeleteGuildDialog: () => null,
  KookDeleteChannelDialog: () => null,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))

import { KookChannel } from '../Kook'

describe('KookChannel', () => {
  it('renders the KOOK Gateway header', () => {
    render(<KookChannel />)
    expect(screen.getByText('KOOK Gateway')).toBeTruthy()
  })

  it('shows disconnected status', () => {
    render(<KookChannel />)
    expect(screen.getByText('disconnected')).toBeTruthy()
  })
})
