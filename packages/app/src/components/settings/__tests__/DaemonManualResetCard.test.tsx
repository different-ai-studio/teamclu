import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const forceResetMock = vi.hoisted(() => vi.fn(async () => {}))

const onboardingState = vi.hoisted(() => ({
  busy: false,
  error: null as string | null,
  forceReset: forceResetMock,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string'
        ? fallback
        : String(fallback?.defaultValue ?? _key),
  }),
}))

vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: Object.assign(
    (selector: (state: typeof onboardingState) => unknown) => selector(onboardingState),
    { getState: () => onboardingState },
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

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('DaemonManualResetCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onboardingState.busy = false
    onboardingState.error = null
  })

  it('requires typing RESET before confirming manual daemon reset', async () => {
    const onResetComplete = vi.fn()
    const { DaemonManualResetCard } = await import('../DaemonManualResetCard')
    render(<DaemonManualResetCard onResetComplete={onResetComplete} />)

    fireEvent.click(screen.getByRole('button', { name: '重置本地 daemon' }))
    const confirmButton = screen.getByRole('button', { name: '确认重置' })
    expect(confirmButton).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('RESET'), { target: { value: 'RESET' } })
    expect(confirmButton).not.toBeDisabled()

    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(forceResetMock).toHaveBeenCalledTimes(1)
      expect(onResetComplete).toHaveBeenCalledTimes(1)
    })
  })
})
