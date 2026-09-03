import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
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

// Feeds the runtime picker's install-status badges. The real store reaches for
// `@/lib/utils`, which this file mocks down to two functions, so it cannot
// initialize here.
vi.mock('@/stores/setup', () => ({
  useSetupStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      agentRuntimes: [
        { id: 'opencode', title: 'OpenCode', optional: false, present: true, version: '1.0.0' },
        { id: 'pi', title: 'Pi', optional: false, present: true, version: '0.81.1' },
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

describe('DaemonGeneralSection team secret', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_daemon_team_id') return 'team-1'
      if (cmd === 'team_share_get_team_secret') return null
      if (cmd === 'team_share_set_team_secret') return null
      return null
    })
  })

  it('renders TeamSecretEntry and saves via team_share_set_team_secret', async () => {
    const { DaemonGeneralSection } = await import('../DaemonGeneralSection')
    render(<DaemonGeneralSection />)

    await waitFor(() => {
      expect(screen.getByLabelText(/团队密钥|Team secret|settings\.teamSecret\.label/i)).toBeTruthy()
    })

    const hex = 'ab'.repeat(32)
    const input = screen.getByLabelText(/团队密钥|Team secret|settings\.teamSecret\.label/i)
    fireEvent.change(input, { target: { value: hex } })

    const saveBtn = screen.getByRole('button', { name: /保存|Save|common\.save/i })
    await waitFor(() => expect(saveBtn).not.toBeDisabled())
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('team_share_set_team_secret', {
        teamId: 'team-1',
        secretHex: hex,
        workspacePath: '/workspace',
      })
    })
  })
})
