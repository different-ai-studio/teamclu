import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, isTauri: () => true, removeStartupSkeleton: () => {} }
})

// Two locales, unlocked: the language step has something to ask.
vi.mock('@/lib/i18n', () => ({
  isLocaleLocked: false,
  availableLanguages: ['en', 'zh-CN'],
  default: { t: (_k: string, fallback?: string) => fallback ?? _k },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(
    () => ({ session: null, loading: false, authFlow: null, hydrate: async () => {}, signOut: vi.fn() }),
    { getState: () => ({ session: null }) },
  ),
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: Object.assign((sel: (s: Record<string, unknown>) => unknown) => sel({ team: null }), {
    getState: () => ({ team: null }),
  }),
  readCachedCurrentTeam: () => null,
}))
vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ status: 'ready', loaded: true, refresh: vi.fn() }),
}))

vi.mock('@/components/onboarding/LanguageStep', () => ({
  LanguageStep: ({ onDone }: { onDone: () => void }) => (
    <button type="button" onClick={onDone}>
      language step
    </button>
  ),
}))
vi.mock('../DesktopOnboarding', () => ({ DesktopOnboarding: () => <div>sign in</div> }))
vi.mock('@/components/auth/DaemonOnboardingWizard', () => ({ DaemonOnboardingWizard: () => null }))
vi.mock('@/components/auth/PendingInvitesDialog', () => ({ PendingInvitesDialog: () => null }))

import { AuthGate } from '../AuthGate'
import { useOnboardingStore } from '@/stores/onboarding'

/**
 * The first-run gate ahead of sign-in is the language step and nothing else
 * (#1250). Picking a runtime and installing it moved into the post-login
 * daemon wizard, where the daemon's own doctor decides — so there is no
 * "setup done" record here for an upgrade to trip over.
 */
describe('AuthGate first-run onboarding gate', () => {
  beforeEach(() => {
    useOnboardingStore.getState().reset()
  })

  it('asks for the language first', () => {
    render(<AuthGate>app</AuthGate>)
    expect(screen.getByText('language step')).toBeInTheDocument()
    expect(screen.queryByText('sign in')).not.toBeInTheDocument()
  })

  it('goes straight to sign-in once the language is answered', async () => {
    render(<AuthGate>app</AuthGate>)
    fireEvent.click(screen.getByText('language step'))
    expect(useOnboardingStore.getState().languageAck).toBe(true)
    expect(await screen.findByText('sign in')).toBeInTheDocument()
    expect(screen.queryByText('language step')).not.toBeInTheDocument()
  })

  it('does not ask again on a machine that already answered', async () => {
    useOnboardingStore.getState().markLanguageAck()
    render(<AuthGate>app</AuthGate>)
    expect(screen.queryByText('language step')).not.toBeInTheDocument()
    expect(await screen.findByText('sign in')).toBeInTheDocument()
  })
})
