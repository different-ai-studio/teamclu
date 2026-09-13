import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

const mockGetLocalDaemonAgent = vi.hoisted(() => vi.fn())
// Stable across renders: `load` depends on these, and a fresh fn per render
// would re-run the load effect on every render.
const mockClearDaemonGeneralPrompt = vi.hoisted(() => vi.fn())
const mockCheckCloudSession = vi.hoisted(() => vi.fn(async () => {}))
const mockAutoHealCloudSession = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ team: { id: 'team-1' }, currentMember: { id: 'member-1' } }),
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
      checkCloudSession: mockCheckCloudSession,
      autoHealCloudSession: mockAutoHealCloudSession,
    }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ daemonGeneralPrompt: null, clearDaemonGeneralPrompt: mockClearDaemonGeneralPrompt }),
}))

vi.mock('@/stores/daemon-mqtt-status', () => ({
  useDaemonMqttConnected: () => true,
}))

vi.mock('@/lib/daemon/daemon-agent-admin', () => ({
  getLocalDaemonAgent: (...args: unknown[]) => mockGetLocalDaemonAgent(...args),
  getDaemonVersion: vi.fn(async () => '1.0.0'),
  listAgentAccess: vi.fn(async () => []),
  listTeamMembersForAccess: vi.fn(async () => []),
  removeAgentAccess: vi.fn(async () => {}),
  updateCurrentDaemonAgent: vi.fn(async () => {}),
  upsertAgentAccess: vi.fn(async () => {}),
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  reloadDaemonRuntime: vi.fn(),
  encodeWorkspaceId: (path: string) => `id:${path}`,
  getDaemonHttpEndpoint: vi.fn(async () => null),
  openDaemonSetupConsole: vi.fn(),
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

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}))

vi.mock('@/components/ui/alert-dialog', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
      open ? <div>{children}</div> : null,
    AlertDialogContent: Passthrough,
    AlertDialogHeader: Passthrough,
    AlertDialogTitle: Passthrough,
    AlertDialogDescription: Passthrough,
    AlertDialogFooter: Passthrough,
    AlertDialogCancel: Passthrough,
    AlertDialogAction: Passthrough,
  }
})

const NO_AGENT = 'No daemon agent is associated with this machine yet.'

describe('DaemonGeneralSection without a network', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Offline, the Cloud API client lets fetch's bare TypeError through, and this
  // section used to print its message in a red "Error" card.
  it('shows an offline notice instead of the raw fetch error', async () => {
    mockGetLocalDaemonAgent.mockRejectedValue(new TypeError('Failed to fetch'))
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    expect(await screen.findByTestId('daemon-general-offline')).toHaveTextContent(
      "Can't reach the server",
    )
    expect(screen.queryByText('Failed to fetch')).toBeNull()
    expect(screen.queryByText('Error')).toBeNull()
    // The agent was never loaded, so saying none is bound would be wrong.
    expect(screen.queryByText(NO_AGENT)).toBeNull()
  })

  it('reloads on its own once the network comes back', async () => {
    mockGetLocalDaemonAgent.mockRejectedValueOnce(new TypeError('Load failed'))
    mockGetLocalDaemonAgent.mockResolvedValue(null)
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)
    await screen.findByTestId('daemon-general-offline')
    expect(mockGetLocalDaemonAgent).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(new Event('online'))
    })

    await waitFor(() => expect(screen.queryByTestId('daemon-general-offline')).toBeNull())
    expect(mockGetLocalDaemonAgent).toHaveBeenCalledTimes(2)
    expect(screen.getByText(NO_AGENT)).toBeInTheDocument()
  })

  it('still shows errors that are not about the network', async () => {
    mockGetLocalDaemonAgent.mockRejectedValue(new Error('agent lookup exploded'))
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    expect(await screen.findByText('agent lookup exploded')).toBeInTheDocument()
    expect(screen.queryByTestId('daemon-general-offline')).toBeNull()
  })
})
