import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: unknown) => {
      // mirror i18next default-value semantics used by the component
      if (typeof d === 'string') return d
      if (d && typeof d === 'object' && 'defaultValue' in (d as Record<string, unknown>)) {
        return String((d as Record<string, unknown>).defaultValue)
      }
      return k
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}))

const { storeState } = vi.hoisted(() => ({
  storeState: {
    wecom: {
      enabled: true,
      bots: [
        { enabled: true, botId: 'b1', secret: 's1' },
        { enabled: true, botId: 'b2', secret: 's2' },
      ],
    },
    wecomIsLoading: false,
    wecomGatewayStatus: { status: 'disconnected', botId: '', errorMessage: '' },
    wecomHasChanges: false,
    wecomBotStatuses: [] as Array<{ botId: string; connected: boolean; error?: string }>,
    loadWecomConfig: vi.fn(),
    loadWecomBotStatuses: vi.fn(),
    saveWecomConfig: vi.fn(),
    startWecomGateway: vi.fn(),
    stopWecomGateway: vi.fn(),
    refreshWecomStatus: vi.fn(),
    setWecomHasChanges: vi.fn(),
    toggleWecomEnabled: vi.fn(),
    startWecomQrAuth: vi.fn(),
    pollWecomQrAuth: vi.fn(),
  },
}))

vi.mock('@/stores/channels-store', () => ({
  // support both useChannelsStore() and useChannelsStore(selector)
  useChannelsStore: vi.fn((selector?: (s: typeof storeState) => unknown) =>
    typeof selector === 'function' ? selector(storeState) : storeState,
  ),
  defaultWeComConfig: { enabled: false, bots: [] },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: vi.fn((selector?: (s: { team: null }) => unknown) =>
    typeof selector === 'function' ? selector({ team: null }) : { team: null },
  ),
}))

vi.mock('@/lib/daemon-workspaces', () => ({
  getCurrentDaemonWorkspaceAgent: vi.fn(async () => null),
  listDaemonWorkspaces: vi.fn(async () => []),
}))

// NOTE: GatewayStatusCard / shared are intentionally NOT mocked. The card is
// collapsed by default; the tests click the header to expand it and assert on
// the real per-bot form rendered as children.
vi.mock('@/hooks/use-channel-config', () => ({
  useChannelConfig: () => ({
    localConfig: {
      enabled: true,
      bots: [
        { enabled: true, botId: 'b1', secret: 's1' },
        { enabled: true, botId: 'b2', secret: 's2' },
      ],
    },
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
vi.mock('@/lib/build-config', () => ({
  buildConfig: { app: { name: 'TeamClu' } },
  appDisplayName: 'TeamClu',
}))

import { WeComChannel } from '../Wecom'

function expandCard() {
  // The gateway card is collapsed by default; click the header to expand it.
  fireEvent.click(screen.getByText('WeCom Gateway'))
}

describe('WeComChannel', () => {
  it('renders the WeCom Gateway header', () => {
    render(<WeComChannel />)
    expect(screen.getByText('WeCom Gateway')).toBeTruthy()
  })

  it('renders one card per configured bot (b1, b2)', () => {
    render(<WeComChannel />)
    expandCard()
    // bot ids are locale-independent — assert via input values
    const botInputs = screen.getAllByPlaceholderText('Enter your WeCom bot ID')
    const values = botInputs.map((el) => (el as HTMLInputElement).value)
    expect(values).toContain('b1')
    expect(values).toContain('b2')
  })

  it('exposes an add-bot control', () => {
    render(<WeComChannel />)
    expandCard()
    expect(screen.getByText('Add bot')).toBeTruthy()
  })
})
