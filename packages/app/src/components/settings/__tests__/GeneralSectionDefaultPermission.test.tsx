import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mockInvoke = vi.fn()
const mockSyncDefaultPermissionMode = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('i18next', () => ({
  default: {
    language: 'en',
    on: vi.fn(),
    off: vi.fn(),
    changeLanguage: vi.fn(),
  },
}))

vi.mock('@/lib/i18n', () => ({
  changeLanguage: vi.fn(),
}))

vi.mock('@/lib/config/build-config', () => ({
  appShortName: 'teamclu',
  appStoragePrefix: 'teamclu',
  TEAMCLU_DIR: '.teamclu',
  buildConfig: {
    app: { shortName: 'teamclu' },
    defaults: { theme: 'system' },
    team: { llm: { models: [] } },
  },
}))

vi.mock('@/lib/locale', () => ({
  LANGUAGE_OPTIONS: [
    { value: 'en', labelKey: 'common.english', fallback: 'English' },
    { value: 'zh-CN', labelKey: 'common.chinese', fallback: '中文' },
  ],
  getPreferredLanguage: () => 'en',
  normalizeSupportedLanguage: (language: string) => language,
  persistLanguage: vi.fn(),
}))

// The real Radix Select is not keyboard-testable here; render a native select
// and find the permission one by its value ('default' / 'fullAccess' are
// unique among GeneralSection's selects: language is 'en', notifications is
// 'important').
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      data-testid="app-select"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}))

vi.mock('../shared', () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
  ToggleSwitch: ({
    enabled,
    onChange,
  }: {
    enabled: boolean
    onChange: (enabled: boolean) => void
  }) => (
    <button type="button" onClick={() => onChange(!enabled)}>
      {enabled ? 'on' : 'off'}
    </button>
  ),
}))

// GeneralSection mounts TeamDefaultAgentCard → useActorDirectory → getBackend().
// Without a cloud URL that throws an unhandled rejection and fails the suite.
vi.mock('../TeamDefaultAgentCard', () => ({
  TeamDefaultAgentCard: () => null,
}))

vi.mock('@/lib/teamclu/sync-session-permission-mode', () => ({
  syncDefaultPermissionModeToLiveSessions: mockSyncDefaultPermissionMode,
}))

const findSelectByValue = (value: string) =>
  screen
    .getAllByTestId('app-select')
    .find((el) => (el as HTMLSelectElement).value === value)

describe('GeneralSection default permission setting', () => {
  beforeEach(() => {
    vi.resetModules()
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(null)
    mockSyncDefaultPermissionMode.mockReset()
    mockSyncDefaultPermissionMode.mockResolvedValue(undefined)
    window.localStorage.clear()

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  it('renders the default permission card with ask and full-access options', async () => {
    const { GeneralSection } = await import('../GeneralSection')

    render(<GeneralSection />)

    expect(screen.getByText('默认权限')).toBeInTheDocument()
    expect(
      screen.getByText(
        '新会话默认使用的权限模式。修改后会同步应用到未单独设置的进行中会话；已单独设置的会话不受影响。',
      ),
    ).toBeInTheDocument()
    expect(screen.getAllByText('询问').length).toBeGreaterThan(0)
    expect(screen.getAllByText('完全访问').length).toBeGreaterThan(0)

    const select = findSelectByValue('default')
    expect(select).toBeTruthy()
  })

  it('persists the choice and pushes it to live sessions', async () => {
    const { GeneralSection } = await import('../GeneralSection')

    render(<GeneralSection />)

    const select = findSelectByValue('default')
    expect(select).toBeTruthy()
    fireEvent.change(select!, { target: { value: 'fullAccess' } })

    expect(window.localStorage.getItem('teamclu-default-session-permission-mode')).toBe(
      'fullAccess',
    )
    expect(mockSyncDefaultPermissionMode).toHaveBeenCalledTimes(1)
    expect(findSelectByValue('fullAccess')).toBeTruthy()
  })
})
