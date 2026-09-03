import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))

const mockStore = {
  email: { provider: 'gmail', enabled: false, gmailClientId: '', gmailClientSecret: '', gmailEmail: '', gmailAuthorized: false, imapServer: '', imapPort: 993, smtpServer: '', smtpPort: 587, username: '', password: '', displayName: '', allowedSenders: [], labels: [], recipientAlias: '' },
  emailIsLoading: false,
  emailGatewayStatus: { status: 'disconnected', email: '', errorMessage: '' },
  emailHasChanges: false,
  emailIsTesting: false,
  emailTestResult: null,
  saveEmailConfig: vi.fn(), startEmailGateway: vi.fn(), stopEmailGateway: vi.fn(),
  refreshEmailStatus: vi.fn(), testEmailConnection: vi.fn(), gmailAuthorize: vi.fn(),
  setEmailHasChanges: vi.fn(), toggleEmailEnabled: vi.fn(),
}

vi.mock('@/stores/channels-store', () => ({
  useChannelsStore: vi.fn(() => mockStore),
  defaultEmailConfig: { provider: 'gmail', enabled: false, gmailClientId: '', gmailClientSecret: '', gmailEmail: '', gmailAuthorized: false, imapServer: '', imapPort: 993, smtpServer: '', smtpPort: 587, username: '', password: '', displayName: '', allowedSenders: [], labels: [], recipientAlias: '' },
}))
vi.mock('../shared', () => ({
  GmailIcon: () => <span data-testid="gmail-icon" />,
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}))
vi.mock('../EmailSetupWizard', () => ({ EmailSetupWizard: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), openExternalUrl: vi.fn() }))

import { EmailChannel } from '../Email'

describe('EmailChannel', () => {
  it('renders the Email Gateway header', () => {
    render(<EmailChannel />)
    expect(screen.getByText('Email Gateway')).toBeTruthy()
  })

  it('shows disconnected status', () => {
    render(<EmailChannel />)
    expect(screen.getByText('disconnected')).toBeTruthy()
  })
})
