import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, isTauri: () => true, removeStartupSkeleton: () => {} }
})

const { setupState } = vi.hoisted(() => ({
  setupState: { previouslySatisfied: false },
}))
vi.mock('@/stores/setup', () => ({
  useSetupStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ loaded: true, requiredSatisfied: () => true, listRequirements: () => {} }),
  setupPreviouslySatisfied: () => setupState.previouslySatisfied,
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

vi.mock('@/components/onboarding/RoleStep', () => ({ RoleStep: () => <div>role step</div> }))
vi.mock('@/components/onboarding/SetupStep', () => ({
  SetupStep: ({ onDone }: { onDone: () => void }) => (
    <button type="button" onClick={onDone}>
      setup step
    </button>
  ),
}))
vi.mock('../DesktopOnboarding', () => ({ DesktopOnboarding: () => <div>sign in</div> }))
vi.mock('@/components/auth/DaemonOnboardingWizard', () => ({ DaemonOnboardingWizard: () => null }))
vi.mock('@/components/auth/PendingInvitesDialog', () => ({ PendingInvitesDialog: () => null }))

import { AuthGate } from '../AuthGate'
import { useOnboardingStore } from '@/stores/onboarding'

describe('AuthGate first-run onboarding gate', () => {
  beforeEach(() => {
    setupState.previouslySatisfied = false
    useOnboardingStore.getState().reset()
  })

  it('asks for a setup style first', () => {
    render(<AuthGate>app</AuthGate>)
    expect(screen.getByText('role step')).toBeInTheDocument()
  })

  it('moves to setup once a role is picked', () => {
    useOnboardingStore.getState().setRole('developer')
    render(<AuthGate>app</AuthGate>)
    expect(screen.getByText('setup step')).toBeInTheDocument()
  })

  // The guided path used to end on a "connect a model" screen. Setup is now the
  // last step for every role — models are a Settings concern.
  it('ends the flow when setup finishes', async () => {
    useOnboardingStore.getState().setRole('guided')
    useOnboardingStore.getState().setRuntime('pi')
    render(<AuthGate>app</AuthGate>)
    fireEvent.click(screen.getByText('setup step'))
    expect(useOnboardingStore.getState().completed).toBe(true)
    expect(await screen.findByText('sign in')).toBeInTheDocument()
  })

  it('falls through to sign-in once onboarding is done', async () => {
    useOnboardingStore.getState().setRole('developer')
    useOnboardingStore.getState().markCompleted()
    render(<AuthGate>app</AuthGate>)
    // Sign-in appears only after the auth hydrate promise settles.
    expect(await screen.findByText('sign in')).toBeInTheDocument()
    expect(screen.queryByText('role step')).not.toBeInTheDocument()
  })

  // Upgrading users have deps installed but no onboarding record. Re-running
  // them through a first-run flow they never asked for would be a regression.
  it('does not re-onboard an existing install', async () => {
    setupState.previouslySatisfied = true
    render(<AuthGate>app</AuthGate>)
    expect(screen.queryByText('role step')).not.toBeInTheDocument()
    expect(await screen.findByText('sign in')).toBeInTheDocument()
  })
})
