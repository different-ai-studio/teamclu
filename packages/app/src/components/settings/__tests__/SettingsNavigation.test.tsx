import * as React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('@/lib/config/version', () => ({
  useAppVersion: () => '2.4.1',
}))

vi.mock('@/stores/updater', () => ({
  useUpdaterStore: (selector: (state: unknown) => unknown) =>
    selector({
      update: { state: 'idle' },
      checkForUpdates: vi.fn(),
      restart: vi.fn(),
    }),
}))

vi.mock('@/lib/config/build-config', () => ({
  TEAMCLU_DIR: '.teamclu',
  appShortName: 'teamclu',
  buildConfig: {
    app: {
      name: 'TeamClu',
      shortName: 'teamclu',
    },
    features: {
      channels: true,
    },
  },
  hasAnyChannel: () => true,
}))

vi.mock('@/stores/team-mode', () => ({
  useTeamModeStore: (selector: (state: unknown) => unknown) =>
    selector({
      teamModeType: null,
    }),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({
      settingsInitialSection: null,
    }),
}))

vi.mock('../section-registry', () => ({
  SettingsSectionBody: ({ section }: { section: string }) => <main data-testid="settings-section">{section}</main>,
}))

const settingsNavState = vi.hoisted(() => ({
  settingsInitialSection: 'diagnostics' as string | null,
}))

describe('Settings navigation', () => {
  it('default entry shows Desktop + Daemon + Local Agent groups together', async () => {
    const { Settings } = await import('../Settings')

    render(<Settings />)

    const clientButton = screen.getByRole('button', { name: 'Desktop' })
    const daemonButton = screen.getByRole('button', { name: 'Daemon' })
    const localAgentButton = screen.getByRole('button', { name: 'Local Agent' })
    const topLevelButtons = screen.getAllByRole('button')
    expect(topLevelButtons.indexOf(clientButton)).toBeLessThan(topLevelButtons.indexOf(daemonButton))
    expect(topLevelButtons.indexOf(daemonButton)).toBeLessThan(topLevelButtons.indexOf(localAgentButton))

    // Desktop group expanded by default (active section is general).
    expect(screen.getByTestId('client-subnav')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Shortcuts' })).toBeInTheDocument()
    // Team Shared is gone: sync is always on, so there is nothing to enable and
    // no mode to pick.
    expect(screen.queryByRole('button', { name: 'Team Shared' })).toBeNull()

    // Daemon / Local Agent present but collapsed until expanded.
    fireEvent.click(daemonButton)
    expect(
      within(screen.getByTestId('daemon-subnav')).getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['General', 'Workspace', 'Automation', 'Channels'])

    fireEvent.click(localAgentButton)
    expect(
      within(screen.getByTestId('local-agent-subnav')).getAllByRole('button').map((button) => button.textContent),
    ).toEqual([
      'LLM Model',
      // 'Team LLM' is gone: the team gateway is now a pinned card inside the
      // LLM Model pane, not a section of its own.
      'Knowledge Access',
      'Prompt',
      // 'Roles' and 'Role Skills' are temporarily hidden — see
      // HIDDEN_LOCAL_AGENT_SECTIONS in Settings.tsx. 'Knowledge Base' is gone
      // for good: it configured the RAG index, which no longer exists.
      'Dependencies',
    ])
  })

  it('daemonGeneral deep link expands Daemon while keeping Desktop + Local Agent visible', async () => {
    vi.resetModules()
    vi.doMock('@/stores/ui', () => ({
      useUIStore: (selector: (state: unknown) => unknown) =>
        selector({ settingsInitialSection: 'daemonGeneral' }),
    }))
    const { Settings } = await import('../Settings')

    render(<Settings />)

    expect(screen.getByRole('button', { name: 'Desktop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Daemon' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Local Agent' })).toBeInTheDocument()

    // Daemon group expanded (active section is daemonGeneral).
    const daemonSubnav = screen.getByTestId('daemon-subnav')
    expect(
      within(daemonSubnav).getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['General', 'Workspace', 'Automation', 'Channels'])

    expect(screen.getByTestId('settings-section')).toHaveTextContent('daemonGeneral')
    vi.doUnmock('@/stores/ui')
  })

  it('follows settingsInitialSection updates while already open', async () => {
    settingsNavState.settingsInitialSection = 'diagnostics'

    vi.resetModules()
    vi.doMock('@/stores/ui', () => ({
      useUIStore: (selector: (state: unknown) => unknown) =>
        selector({ settingsInitialSection: settingsNavState.settingsInitialSection }),
    }))
    const { Settings } = await import('../Settings')

    const { rerender } = render(<Settings />)
    expect(screen.getByTestId('settings-section')).toHaveTextContent('diagnostics')

    settingsNavState.settingsInitialSection = 'general'
    rerender(<Settings />)
    expect(screen.getByTestId('settings-section')).toHaveTextContent('general')

    vi.doUnmock('@/stores/ui')
  })
})
