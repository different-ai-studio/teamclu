import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockReloadDaemonRuntime = vi.hoisted(() => vi.fn())
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
  getDaemonLocalAgent: vi.fn(async () => 'opencode'),
  setDaemonLocalAgent: vi.fn(async () => {}),
  reloadDaemonRuntime: (...args: unknown[]) => mockReloadDaemonRuntime(...args),
  encodeWorkspaceId: (path: string) => mockEncodeWorkspaceId(path),
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

describe('DaemonGeneralSection force reload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReloadDaemonRuntime.mockResolvedValue('restart_required')
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_daemon_team_id') return 'team-1'
      return null
    })
  })

  it('shows force-reload control and reloads only after confirm', async () => {
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    const openBtn = await screen.findByTestId('daemon-force-reload-runtime')
    fireEvent.click(openBtn)

    expect(await screen.findByTestId('force-reload-dialog')).toBeTruthy()
    expect(mockReloadDaemonRuntime).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('daemon-force-reload-confirm'))

    await waitFor(() => {
      expect(mockReloadDaemonRuntime).toHaveBeenCalledWith('id:/workspace')
    })
  })

  it('does not reload when confirm dialog is cancelled', async () => {
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    fireEvent.click(await screen.findByTestId('daemon-force-reload-runtime'))
    expect(await screen.findByTestId('force-reload-dialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Cancel|取消/i }))

    await waitFor(() => {
      expect(screen.queryByTestId('force-reload-dialog')).toBeNull()
    })
    expect(mockReloadDaemonRuntime).not.toHaveBeenCalled()
  })

  it('coalesces repeated confirm clicks while reload is in flight', async () => {
    let resolveReload: ((value: string) => void) | undefined
    mockReloadDaemonRuntime.mockImplementation(
      () => new Promise<string>((resolve) => { resolveReload = resolve }),
    )
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    fireEvent.click(await screen.findByTestId('daemon-force-reload-runtime'))
    const confirm = await screen.findByTestId('daemon-force-reload-confirm')
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(mockReloadDaemonRuntime).toHaveBeenCalledTimes(1)
    resolveReload?.('restart_required')
    await waitFor(() => {
      expect(screen.queryByTestId('force-reload-dialog')).toBeNull()
    })
  })
})
