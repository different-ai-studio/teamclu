import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MainWindowRoot } from '@/components/MainWindowRoot'

const invoke = vi.fn()
const closeHandlers: Array<() => void> = []

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: () => void) => {
    if (event === 'window-close-requested') closeHandlers.push(handler)
    return () => {}
  },
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, isTauri: () => true }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// First run: AuthGate is showing the language step / onboarding and withholds
// its children, so nothing inside App is mounted.
vi.mock('@/components/auth/AuthGate', () => ({
  AuthGate: () => <div data-testid="onboarding-screen" />,
}))
vi.mock('@/App', () => ({
  default: () => <div data-testid="workspace-shell" />,
}))
vi.mock('@/components/extension/SidePanelHostGateOverlay', () => ({
  SidePanelHostGateOverlay: () => null,
}))
vi.mock('@/components/invite/InviteLinkConfirmDialog', () => ({
  InviteLinkConfirmDialog: () => null,
}))
vi.mock('@/components/updater/UpdateDialog', () => ({
  UpdateDialogContainer: () => null,
}))

describe('MainWindowRoot', () => {
  beforeEach(() => {
    invoke.mockReset()
    closeHandlers.length = 0
  })

  // #1403: the Rust side prevents the close and asks the frontend. The only
  // listener lived inside App, so on the onboarding screens the close button
  // did nothing at all.
  it('answers the window close button while AuthGate is still onboarding', async () => {
    render(<MainWindowRoot />)
    expect(screen.getByTestId('onboarding-screen')).toBeTruthy()
    expect(screen.queryByTestId('workspace-shell')).toBeNull()

    await waitFor(() => expect(closeHandlers.length).toBeGreaterThan(0))
    closeHandlers.forEach((handler) => handler())

    expect(await screen.findByTestId('close-to-tray-dialog')).toBeTruthy()
    fireEvent.click(screen.getByTestId('close-confirm'))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('hide_main_to_tray')
    })
  })
})
