import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockReloadDaemonRuntime = vi.hoisted(() => vi.fn())
const mockGetDaemonHttpEndpoint = vi.hoisted(() => vi.fn())
const mockOpenDaemonSetupConsole = vi.hoisted(() => vi.fn())
const mockEncodeWorkspaceId = vi.hoisted(() => vi.fn((path: string) => `id:${path}`))
const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      team: { id: 'team-1' },
      currentMember: { id: 'member-1' },
    }),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ workspacePath: '/workspace' }),
}))

vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      status: 'ready',
      busy: false,
      cloudAuthExpired: false,
      healing: false,
      healError: null,
      checkCloudSession: vi.fn(async () => {}),
      autoHealCloudSession: vi.fn(async () => {}),
    }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      daemonGeneralPrompt: null,
      clearDaemonGeneralPrompt: vi.fn(),
    }),
}))

vi.mock('@/stores/daemon-mqtt-status', () => ({
  useDaemonMqttConnected: () => true,
}))

vi.mock('@/stores/setup', () => ({
  useSetupStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentRuntimes: [
        { id: 'opencode', title: 'OpenCode', optional: false, present: true, version: '1.0.0' },
      ],
      listAgentRuntimes: vi.fn(async () => {}),
    }),
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonAgent: vi.fn(async () => null),
  getDaemonVersion: vi.fn(async () => '1.0.0'),
  listAgentAccess: vi.fn(async () => []),
  listTeamMembersForAccess: vi.fn(async () => []),
  removeAgentAccess: vi.fn(async () => {}),
  updateCurrentDaemonAgent: vi.fn(async () => {}),
  upsertAgentAccess: vi.fn(async () => {}),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  getCursorAgentSettings: vi.fn(async () => ({ apiKeyConfigured: false })),
  reloadDaemonRuntime: (...args: unknown[]) => mockReloadDaemonRuntime(...args),
  encodeWorkspaceId: (path: string) => mockEncodeWorkspaceId(path),
  getDaemonHttpEndpoint: (...args: unknown[]) => mockGetDaemonHttpEndpoint(...args),
  openDaemonSetupConsole: (...args: unknown[]) => mockOpenDaemonSetupConsole(...args),
}))

vi.mock('@/stores/local-daemon-catalog-store', () => ({
  ensureLocalDaemonCatalog: vi.fn(),
}))

vi.mock('@/lib/skills/ensure-agents-paths', () => ({
  ensureAgentsSkillsPaths: vi.fn(),
}))

vi.mock('@/components/auth/DaemonOnboardingWizard', () => ({
  DaemonOnboardingWizard: () => null,
}))

vi.mock('../DaemonManualResetCard', () => ({
  DaemonManualResetCard: () => null,
}))

vi.mock('../team/TeamSecretEntry', () => ({
  TeamSecretEntry: () => null,
}))

vi.mock('../shared', () => ({
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}))

const alertDialogOnOpenChange = vi.hoisted(() => ({ current: null as null | ((open: boolean) => void) }))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    alertDialogOnOpenChange.current = onOpenChange ?? null
    return open ? <div data-testid="force-reload-dialog">{children}</div> : null
  },
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event)
        alertDialogOnOpenChange.current?.(false)
      }}
    >
      {children}
    </button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))

describe('DaemonGeneralSection daemon endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDaemonHttpEndpoint.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:60243',
      port: 60243,
    })
    mockOpenDaemonSetupConsole.mockResolvedValue(true)
    mockInvoke.mockResolvedValue(null)
  })

  // amuxd binds `127.0.0.1:0`, so before this the only ways to learn the port
  // were `amuxd setup` in a terminal or reading ~/.amuxd/run/amuxd.http.port.
  it('shows the address and the port the daemon actually bound', async () => {
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    expect(await screen.findByTestId('daemon-endpoint-url')).toHaveTextContent(
      'http://127.0.0.1:60243',
    )
    expect(screen.getByTestId('daemon-endpoint-port')).toHaveTextContent('60243')
  })

  it('opens the web config without the token passing through the component', async () => {
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    fireEvent.click(await screen.findByTestId('daemon-open-web-config'))

    await waitFor(() => expect(mockOpenDaemonSetupConsole).toHaveBeenCalledTimes(1))
    // No argument: the URL and its root token are built inside the client, so
    // there is nothing here to render, copy or log.
    expect(mockOpenDaemonSetupConsole).toHaveBeenCalledWith()
  })

  it('says the daemon is down rather than showing an empty address', async () => {
    mockGetDaemonHttpEndpoint.mockResolvedValue(null)
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    await waitFor(() => expect(mockGetDaemonHttpEndpoint).toHaveBeenCalled())
    expect(screen.queryByTestId('daemon-endpoint-url')).toBeNull()
    expect(
      screen.getByText('The local daemon is not running, so it has no port yet.'),
    ).toBeInTheDocument()
  })

  it('re-reads the endpoint on Refresh, because a restart moves the port', async () => {
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)
    await waitFor(() => expect(mockGetDaemonHttpEndpoint).toHaveBeenCalled())
    const before = mockGetDaemonHttpEndpoint.mock.calls.length

    mockGetDaemonHttpEndpoint.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:51111',
      port: 51111,
    })
    fireEvent.click(screen.getByText('Refresh'))

    await waitFor(() =>
      expect(mockGetDaemonHttpEndpoint.mock.calls.length).toBeGreaterThan(before),
    )
    expect(await screen.findByTestId('daemon-endpoint-port')).toHaveTextContent('51111')
  })
})
