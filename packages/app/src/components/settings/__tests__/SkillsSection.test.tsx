import * as React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const t = (k: string, d?: string) => d ?? k

const { workspaceState, mockLoadAllSkills, mockInvoke, mockPutDaemonPermissions, mockGetDaemonPermissions } = vi.hoisted(() => ({
  workspaceState: { workspacePath: null as string | null },
  mockLoadAllSkills: vi.fn(async () => ({ skills: [], overrides: [] })),
  mockInvoke: vi.fn(),
  mockPutDaemonPermissions: vi.fn(),
  mockGetDaemonPermissions: vi.fn(),
}))
const { mockLoadRolesSkillsWorkspaceState } = vi.hoisted(() => ({
  mockLoadRolesSkillsWorkspaceState: vi.fn(async () => ({
    roles: [],
    skills: [],
    roleUsageBySkill: {},
    skillNamesByRole: {},
    metrics: {
      rolesCount: 0,
      skillsCount: 0,
      linkedSkillsCount: 0,
      unlinkedSkillsCount: 0,
    },
  })),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => {
    return sel(workspaceState)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' '), isTauri: () => false }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => undefined),
}))
vi.mock('@/lib/opencode/config', () => ({
  readSkillPermissions: vi.fn(async () => ({})),
  writeSkillPermission: vi.fn(),
  removeSkillPermission: vi.fn(),
  resolveSkillPermission: vi.fn(() => ({ permission: 'allow', isExact: false })),
}))
vi.mock('@/lib/skills/loader', () => ({
  loadAllSkills: mockLoadAllSkills,
}))
vi.mock('@/lib/roles/loader', () => ({
  loadRolesSkillsWorkspaceState: mockLoadRolesSkillsWorkspaceState,
}))
vi.mock('@/lib/skills/types', () => ({
  INHERENT_SKILL_NAMES: new Set(),
}))
vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))
vi.mock('../ClawHubMarketplace', () => ({
  ClawHubMarketplace: () => {
    const [ready, setReady] = React.useState(false)

    React.useEffect(() => {
      const timer = window.setTimeout(() => setReady(true), 0)
      return () => window.clearTimeout(timer)
    }, [])

    return ready ? (
      <div data-testid="marketplace-content">Marketplace content</div>
    ) : (
      <div data-slot="skeleton">Marketplace loading</div>
    )
  },
}))
vi.mock('../SkillsDiagnosticsDialog', () => ({
  SkillsDiagnosticsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="skills-diagnostics-dialog">Diagnostics open</div> : null,
}))
vi.mock('@/lib/daemon/daemon-local-client', () => ({
  encodeWorkspaceId: (path: string) => path,
  getDaemonPermissions: mockGetDaemonPermissions,
  putDaemonPermissions: mockPutDaemonPermissions,
  reloadDaemonRuntime: vi.fn(),
  deleteDaemonSkill: vi.fn(),
}))
import { SkillsSection } from '../SkillsSection'

describe('SkillsSection', () => {
  beforeEach(() => {
    workspaceState.workspacePath = null
    mockLoadAllSkills.mockReset()
    mockLoadAllSkills.mockResolvedValue({ skills: [], overrides: [] })
    mockLoadRolesSkillsWorkspaceState.mockReset()
    mockLoadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [],
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: {
        rolesCount: 0,
        skillsCount: 0,
        linkedSkillsCount: 0,
        unlinkedSkillsCount: 0,
      },
    })
    mockInvoke.mockReset()
    mockGetDaemonPermissions.mockReset()
    mockGetDaemonPermissions.mockResolvedValue({ '*': 'ask' })
    mockPutDaemonPermissions.mockReset()
    mockPutDaemonPermissions.mockResolvedValue(null)
    mockInvoke.mockImplementation(async (method: string) => {
      if (method === 'clawhub_list_installed') return { skills: {} }
      if (method === 'clawhub_explore') return { items: [], nextCursor: null }
      return {}
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('shows invocation name for bundled skills', async () => {
    workspaceState.workspacePath = '/workspace/project'
    mockLoadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [
        {
          filename: 'brainstorming',
          name: 'brainstorming',
          invocationName: 'superpowers/brainstorming',
          content: '---\ndescription: Brainstorm first\n---\nBody',
          source: 'global-agent',
          dirPath: '/home/user/.agents/skills/superpowers',
          linkedRoles: [],
          isRoleSkill: false,
        },
      ] as any,
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: {
        rolesCount: 0,
        skillsCount: 1,
        linkedSkillsCount: 0,
        unlinkedSkillsCount: 1,
      },
    })

    render(<SkillsSection />)

    expect(await screen.findByText('superpowers/brainstorming')).toBeTruthy()
  })

  it('renders role-managed skills in standalone mode', async () => {
    workspaceState.workspacePath = '/workspace/project'
    mockLoadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [
        {
          filename: 'design-helper',
          name: 'design-helper',
          invocationName: 'skills/design-helper',
          content: '---\ndescription: Helps design tasks\n---\nBody',
          source: 'local',
          dirPath: '/workspace/.opencode/roles/skills',
          linkedRoles: ['default-role'],
          isRoleSkill: true,
        },
      ] as any,
      roleUsageBySkill: {
        'design-helper': ['default-role'],
      },
      skillNamesByRole: {
        'default-role': ['design-helper'],
      },
      metrics: {
        rolesCount: 1,
        skillsCount: 1,
        linkedSkillsCount: 1,
        unlinkedSkillsCount: 0,
      },
    })

    render(<SkillsSection />)

    expect(await screen.findByText('Role Skill')).toBeTruthy()
  })

  it('renders the Skills title', () => {
    render(<SkillsSection />)
    expect(screen.getByText('Skills')).toBeTruthy()
  })

  it('shows workspace selection prompt when no workspace', () => {
    render(<SkillsSection />)
    expect(screen.getByText('Please select a workspace directory first')).toBeTruthy()
  })

  it('opens the create skill flow from Add Skill', async () => {
    workspaceState.workspacePath = '/workspace/project'

    render(<SkillsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Skill' }))

    expect(await screen.findByText('Create New Skill')).toBeTruthy()
  })

  it('opens skills diagnostics from Diagnose button', async () => {
    workspaceState.workspacePath = '/workspace/project'

    render(<SkillsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Diagnose' }))

    expect(await screen.findByTestId('skills-diagnostics-dialog')).toBeTruthy()
  })

  it('shows ZIP import installs into ~/.agents/skills', async () => {
    workspaceState.workspacePath = '/workspace/project'

    render(<SkillsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add Skill' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import Skill from ZIP' }))

    expect(await screen.findByText(/Install Location/)).toBeTruthy()
    expect(screen.getByText('~/.agents/skills/')).toBeTruthy()
  })

  it('exposes the installed and marketplace switch as tabs in embedded mode', async () => {
    workspaceState.workspacePath = '/workspace/project'

    render(<SkillsSection embeddedConsole />)

    expect(screen.queryByText('Skill library')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Installed' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Marketplace' })).toBeTruthy()
  })

  it('orders the embedded toolbar from tabs to source to search and actions', async () => {
    workspaceState.workspacePath = '/workspace/project'

    render(<SkillsSection embeddedConsole />)

    const installedTab = screen.getByRole('tab', { name: 'Installed' })
    const marketplaceTab = screen.getByRole('tab', { name: 'Marketplace' })
    const searchInput = screen.getByPlaceholderText('Search skills...')
    const refreshButton = screen.getByRole('button', { name: 'Refresh' })
    const addButton = screen.getByRole('button', { name: 'Add Skill' })

    expect(installedTab.compareDocumentPosition(marketplaceTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(marketplaceTab.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(searchInput.compareDocumentPosition(refreshButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(refreshButton.compareDocumentPosition(addButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the marketplace panel immediately and skeletonizes while ClawHub loads', async () => {
    workspaceState.workspacePath = '/workspace/project'
    mockLoadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [
        {
          filename: 'installed-example',
          name: 'Installed Example',
          invocationName: 'skills/installed-example',
          content: '---\ndescription: Installed example\n---\nBody',
          source: 'local',
          dirPath: '/workspace/.opencode/skills',
          linkedRoles: [],
          isRoleSkill: false,
        },
      ] as any,
      roleUsageBySkill: {},
      skillNamesByRole: {},
      metrics: {
        rolesCount: 0,
        skillsCount: 1,
        linkedSkillsCount: 0,
        unlinkedSkillsCount: 1,
      },
    })

    const { container } = render(<SkillsSection embeddedConsole />)

    expect(await screen.findByText('Installed Example')).toBeTruthy()
    expect(screen.queryByRole('tabpanel', { name: 'Marketplace' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Marketplace' }))

    const marketplacePanel = screen.getByRole('tabpanel', { name: 'Marketplace' })
    expect(marketplacePanel).toBeTruthy()
    expect(marketplacePanel.querySelector('[data-slot="skeleton"]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Marketplace' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('Installed Example')).toBeNull()
    expect(container.querySelector('#installed-panel')).toBeNull()

    const searchInput = screen.getByPlaceholderText('Search marketplace skills...')
    const refreshButton = screen.getByRole('button', { name: 'Refresh' })

    expect(screen.getByRole('tab', { name: 'Installed' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Marketplace' })).toBeTruthy()
    // The source picker used to be asserted here too. It offered ClawHub and
    // skills.sh; with skills.sh retired it was a one-option control, so it is
    // gone — the chrome that remains still has to stay interactive.
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(searchInput.closest('[aria-busy="true"]')).toBeNull()
    expect(refreshButton.closest('[aria-busy="true"]')).toBeNull()

    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy()

    await waitFor(() => {
      expect(screen.getByTestId('marketplace-content')).toBeTruthy()
    })
  })

  it('does not claim a permission write succeeded when the daemon is down', async () => {
    workspaceState.workspacePath = '/workspace/project'
    mockPutDaemonPermissions.mockResolvedValue(null)

    render(<SkillsSection />)

    expect(await screen.findByText('Default Permission')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ask' }).className).toMatch(/bg-accent/)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    expect(await screen.findByText('Could not save permission. Is the daemon running?')).toBeTruthy()
    expect(mockPutDaemonPermissions).toHaveBeenCalled()
    // Local state stays on the last loaded value (ask), not the clicked allow.
    const allow = screen.getByRole('button', { name: 'Allow' })
    const ask = screen.getByRole('button', { name: 'Ask' })
    expect(ask.className.split(' ')).toContain('bg-accent')
    expect(allow.className.split(' ')).not.toContain('bg-accent')
  })

  it('updates local permission state only after the daemon accepts the write', async () => {
    workspaceState.workspacePath = '/workspace/project'
    mockPutDaemonPermissions.mockResolvedValue({ restartRequired: false })

    render(<SkillsSection />)

    expect(await screen.findByText('Default Permission')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ask' }).className).toMatch(/bg-accent/)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow' }).className).toMatch(/bg-accent/)
    })
    expect(screen.queryByText('Could not save permission. Is the daemon running?')).toBeNull()
  })
})
