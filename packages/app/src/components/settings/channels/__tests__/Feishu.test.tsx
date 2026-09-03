import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/channels-store', () => ({
  useChannelsStore: vi.fn(() => ({
    feishu: { appId: '', appSecret: '', enabled: false, chats: {} },
    feishuIsLoading: false,
    feishuGatewayStatus: { status: 'disconnected', appId: '', errorMessage: '' },
    feishuHasChanges: false,
    feishuIsTesting: false,
    feishuTestResult: null,
    saveFeishuConfig: vi.fn(),
    startFeishuGateway: vi.fn(),
    stopFeishuGateway: vi.fn(),
    refreshFeishuStatus: vi.fn(),
    testFeishuCredentials: vi.fn(),
    clearFeishuTestResult: vi.fn(),
    setFeishuHasChanges: vi.fn(),
    toggleFeishuEnabled: vi.fn(),
  })),
  defaultFeishuConfig: { appId: '', appSecret: '', enabled: false, chats: {} },
}))
vi.mock('./shared', () => ({
  FeishuIcon: () => <span data-testid="feishu-icon" />,
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}))
vi.mock('./GatewayStatusCard', () => ({
  GatewayStatusCard: ({ children, title }: { children: React.ReactNode; title: string }) => <div><span>{title}</span>{children}</div>,
}))
vi.mock('./TestCredentialsButton', () => ({
  TestCredentialsButton: () => <button>Test</button>,
}))
vi.mock('@/hooks/use-channel-config', () => ({
  useChannelConfig: () => ({
    localConfig: { appId: '', appSecret: '', enabled: false, chats: {} },
    updateLocalConfig: vi.fn(),
    isConnecting: false,
    isRunning: false,
    handleSave: vi.fn(),
    handleStartStop: vi.fn(),
    handleRestart: vi.fn(),
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/utils', () => ({ cn: (...args: string[]) => args.join(' '), openExternalUrl: vi.fn() }))

import { FeishuChannel } from '../Feishu'

describe('FeishuChannel', () => {
  it('renders the Feishu Gateway header', () => {
    render(<FeishuChannel />)
    expect(screen.getByText('Feishu Gateway')).toBeTruthy()
  })

  it('returns null when feishu config is null', async () => {
    const mod = await import('@/stores/channels-store') as any
    mod.useChannelsStore.mockReturnValueOnce({
      feishu: null,
      feishuIsLoading: false,
      feishuGatewayStatus: { status: 'disconnected', appId: '', errorMessage: '' },
      feishuHasChanges: false,
      feishuIsTesting: false,
      feishuTestResult: null,
      saveFeishuConfig: vi.fn(), startFeishuGateway: vi.fn(), stopFeishuGateway: vi.fn(),
      refreshFeishuStatus: vi.fn(), testFeishuCredentials: vi.fn(), clearFeishuTestResult: vi.fn(),
      setFeishuHasChanges: vi.fn(), toggleFeishuEnabled: vi.fn(),
    })
    const { container } = render(<FeishuChannel />)
    expect(container.innerHTML).toBe('')
  })
})
