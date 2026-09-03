import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticReport } from '@/lib/diagnostics/diagnostic-report'
import { DiagnosticsSection } from '../DiagnosticsSection';

const forceResetMock = vi.hoisted(() => vi.fn(async () => {}))

const diagnosticsState = vi.hoisted(() => ({
  report: null as DiagnosticReport | null,
}))

const sampleReport: DiagnosticReport = {
  schemaVersion: 2,
  generatedAt: '2026-01-01T00:00:00.000Z',
  app: { version: '1.0.0', buildFlavor: 'default', platform: 'MacIntel', tauri: true },
  summary: { ok: 0, warn: 0, fail: 1 },
  findings: [],
  causeCodes: [],
  traces: [],
  checks: [
    {
      id: 'daemon_http',
      title: '本地 Daemon',
      status: 'fail',
      message: 'daemon 令牌无效，需重启应用',
      resetTrigger: 'daemon_http_token_invalid',
    },
  ],
  details: {} as DiagnosticReport['details'],
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>()
  return {
    ...actual,
    isTauri: () => true,
    openExternalUrl: vi.fn(),
  }
})

vi.mock('@/stores/ui', () => ({
  useUIStore: (
    selector: (state: { openSettings: () => void; closeSettings: () => void }) => unknown,
  ) => selector({ openSettings: vi.fn(), closeSettings: vi.fn() }),
}))

vi.mock('@/stores/diagnostics-store', () => ({
  useDiagnosticsStore: (
    selector: (state: { report: DiagnosticReport | null; setReport: (r: DiagnosticReport) => void }) => unknown,
  ) => selector({ report: diagnosticsState.report, setReport: vi.fn() }),
}))

const onboardingState = vi.hoisted(() => ({
  status: 'ready' as string,
  busy: false,
  healError: null as string | null,
  error: null as string | null,
  forceReset: forceResetMock,
}))

vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: Object.assign(
    (
      selector: (state: typeof onboardingState) => unknown,
    ) => selector(onboardingState),
    {
      getState: () => onboardingState,
    },
  ),
}))

vi.mock('@/lib/diagnostics/diagnostic-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/diagnostics/diagnostic-report')>()
  return {
    ...actual,
    collectDiagnosticReport: vi.fn(),
    copyDiagnosticReport: vi.fn(),
    saveDiagnosticZip: vi.fn(),
  }
})

vi.mock('../LiveDebugConsole', () => ({
  LiveDebugConsole: () => <div data-testid="live-debug-console" />,
}))

vi.mock('@/components/auth/DaemonOnboardingWizard', () => ({
  DaemonOnboardingWizard: ({ onDone }: { onDone: () => void }) => (
    <div data-testid="daemon-onboarding-wizard">
      <button type="button" onClick={onDone}>
        wizard-done
      </button>
    </div>
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

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  AlertDialogAction: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))

describe('DiagnosticsSection daemon reset remediation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    diagnosticsState.report = null
    onboardingState.status = 'ready'
    onboardingState.busy = false
    onboardingState.healError = null
    onboardingState.error = null
  })

  it('shows remediation banner when report qualifies for daemon reset', async () => {
    diagnosticsState.report = sampleReport
    render(<DiagnosticsSection />)

    expect(screen.getByText('建议重置本地 daemon')).toBeTruthy()
    expect(screen.getByText(/daemon 令牌无效，需重启应用/)).toBeTruthy()
  })

  it('runs forceReset and opens onboarding wizard after confirmation', async () => {
    diagnosticsState.report = sampleReport
    render(<DiagnosticsSection />)

    fireEvent.click(screen.getByRole('button', { name: '重置本地 daemon' }))
    expect(screen.getByTestId('alert-dialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认重置' }))

    await waitFor(() => {
      expect(forceResetMock).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('daemon-onboarding-wizard')).toBeTruthy()
  })
})
