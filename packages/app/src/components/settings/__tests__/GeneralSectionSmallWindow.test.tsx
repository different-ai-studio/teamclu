import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockInvoke = vi.fn()
const mockPersistLanguage = vi.fn()
const mockNormalizeSupportedLanguage = vi.fn((language: string) => language)
const mockChangeLanguage = vi.fn()
const mockT = (_key: string, fallback?: string) => fallback ?? _key

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
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

// GeneralSection switches the language through `@/lib/i18n`, not i18next
// directly, because the catalogues are fetched on demand (PERF-15) and only
// that wrapper loads the target one first.
vi.mock('@/lib/i18n', () => ({
  changeLanguage: mockChangeLanguage,
}))

vi.mock('@/lib/build-config', () => ({
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
  normalizeSupportedLanguage: mockNormalizeSupportedLanguage,
  persistLanguage: mockPersistLanguage,
}))

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
      aria-label="Language"
      data-testid="language-select"
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
    disabled,
  }: {
    enabled: boolean
    onChange: (enabled: boolean) => void
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={() => onChange(!enabled)}>
      {enabled ? 'on' : 'off'}
    </button>
  ),
}))

// GeneralSection mounts TeamDefaultAgentCard → useActorDirectory → getBackend().
// Without a cloud URL that throws an unhandled rejection and fails the suite.
vi.mock('../TeamDefaultAgentCard', () => ({
  TeamDefaultAgentCard: () => null,
}))

describe('GeneralSection small-window setting', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_LOCALE', 'all')
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(null)
    mockPersistLanguage.mockReset()
    mockNormalizeSupportedLanguage.mockClear()
    mockChangeLanguage.mockReset()

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
  })

  it('does not render the small-window shortcut setting', async () => {
    const { GeneralSection } = await import('../GeneralSection')

    render(<GeneralSection />)

    expect(screen.queryByText('Small Window Shortcut')).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('switches the app language from General settings', async () => {
    const { GeneralSection } = await import('../GeneralSection')

    render(<GeneralSection />)

    expect(screen.getByText('Language')).toBeInTheDocument()
    expect(screen.getByText('Choose the app display language')).toBeInTheDocument()

    fireEvent.change(screen.getAllByTestId('language-select')[0], { target: { value: 'zh-CN' } })

    expect(mockNormalizeSupportedLanguage).toHaveBeenCalledWith('zh-CN')
    expect(mockChangeLanguage).toHaveBeenCalledWith('zh-CN')
    expect(mockPersistLanguage).toHaveBeenCalledWith('zh-CN')
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('set_config_locale', { locale: 'zh-CN' })
    })
  })
})
