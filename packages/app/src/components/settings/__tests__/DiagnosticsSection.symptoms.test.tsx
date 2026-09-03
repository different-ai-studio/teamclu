import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticReport } from '@/lib/diagnostic-report'
import type { DiagnosticFinding } from '@/lib/diagnostics/types'
import { DiagnosticsSection } from '../DiagnosticsSection'

const diagnosticsState = vi.hoisted(() => ({
  report: null as DiagnosticReport | null,
  focusSessionId: null as string | null,
}))

function finding(overrides: Partial<DiagnosticFinding>): DiagnosticFinding {
  return {
    code: 'model.catalog_ok',
    symptom: 'model',
    status: 'ok',
    confidence: 'high',
    title: '模型目录',
    message: '已探测到模型',
    nextAction: '无需处理',
    evidence: [],
    ...overrides,
  }
}

const sampleReport: DiagnosticReport = {
  schemaVersion: 2,
  generatedAt: '2026-01-01T00:00:00.000Z',
  app: { version: '1.0.0', buildFlavor: 'default', platform: 'MacIntel', tauri: true },
  summary: { ok: 0, warn: 0, fail: 1 },
  findings: [
    finding({
      code: 'model.backend_probe_failed',
      status: 'fail',
      title: '模型探测',
      message: 'provider auth token invalid',
      nextAction: '设置 → LLM，重新连接 provider（provider 鉴权失败）',
      hintSection: 'llm',
      evidence: [{ source: 'daemon.catalog', summary: 'provider auth token invalid' }],
    }),
    finding({
      code: 'send.mqtt_publish_failed',
      symptom: 'send',
      status: 'fail',
      title: 'MQTT 投递',
      message: 'broker down',
      nextAction: '设置 → 通用 → 重新连接 MQTT',
    }),
    finding({
      code: 'realtime.ok',
      symptom: 'realtime',
      status: 'ok',
      title: '实时通道',
      message: '桌面与 daemon MQTT 正常',
    }),
    finding({
      code: 'auth.session_invalid',
      symptom: 'auth_sync',
      status: 'fail',
      title: '登录会话',
      message: '访问令牌已过期',
      nextAction: '请重新登录',
    }),
  ],
  traces: [
    {
      traceId: 'm1',
      sessionId: 'sess-9',
      stage: 'mqtt.publish',
      rawStage: 'outbox_sender.mqtt_publish.failed',
      status: 'error',
      startedAt: '2026-01-01T00:00:01.000Z',
      errorCode: 'broker down',
    },
  ],
  causeCodes: ['model.backend_probe_failed', 'send.mqtt_publish_failed', 'auth.session_invalid'],
  checks: [
    {
      id: 'daemon_http',
      title: '本地 Daemon',
      status: 'ok',
      message: '本地 amuxd 运行正常',
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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>()
  return { ...actual, isTauri: () => true, openExternalUrl: vi.fn() }
})

const { openSettings, recoverMqttConnection, signOut } = vi.hoisted(() => ({
  openSettings: vi.fn(),
  recoverMqttConnection: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: (
    selector: (state: { openSettings: (section?: string) => void; closeSettings: () => void }) => unknown,
  ) => selector({ openSettings, closeSettings: vi.fn() }),
}))

vi.mock('@/stores/mqtt-reconnect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/mqtt-reconnect')>()
  return { ...actual, recoverMqttConnection }
})

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: { signOut: () => Promise<void> }) => unknown) =>
    selector({ signOut }),
}))

vi.mock('@/stores/diagnostics-store', () => ({
  useDiagnosticsStore: (
    selector: (state: {
      report: DiagnosticReport | null
      setReport: (r: DiagnosticReport) => void
      focusSessionId: string | null
    }) => unknown,
  ) =>
    selector({
      report: diagnosticsState.report,
      setReport: vi.fn(),
      focusSessionId: diagnosticsState.focusSessionId,
    }),
}))

vi.mock('@/lib/diagnostic-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/diagnostic-report')>()
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

vi.mock('../DaemonResetRemediationCard', () => ({
  DaemonResetRemediationCard: () => null,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
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

describe('DiagnosticsSection symptom tabs', () => {
  beforeEach(() => {
    diagnosticsState.report = sampleReport
    diagnosticsState.focusSessionId = null
    openSettings.mockClear()
    recoverMqttConnection.mockClear()
    signOut.mockClear()
  })

  it('shows a model conclusion card on the default tab', () => {
    render(<DiagnosticsSection />)
    expect(screen.getByRole('tab', { name: '模型' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '消息回复' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '实时通道' })).toBeTruthy()
    expect(screen.getByText('provider auth token invalid')).toBeTruthy()
    expect(screen.getByText('设置 → LLM，重新连接 provider（provider 鉴权失败）')).toBeTruthy()
    expect(screen.getByText('model.backend_probe_failed')).toBeTruthy()
  })

  it('opens LLM settings from the provider remediation', () => {
    render(<DiagnosticsSection />)
    fireEvent.click(screen.getByRole('button', { name: '重新连接 Provider' }))
    expect(openSettings).toHaveBeenCalledWith('llm')
  })

  it('reconnects MQTT from the send-tab remediation', async () => {
    render(<DiagnosticsSection />)
    fireEvent.click(screen.getByRole('tab', { name: '消息回复' }))
    fireEvent.click(screen.getByRole('button', { name: '重连 MQTT' }))
    expect(recoverMqttConnection).toHaveBeenCalledTimes(1)
  })

  it('confirms relogin from the auth banner', async () => {
    render(<DiagnosticsSection />)
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    expect(screen.getByText('重新登录？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }))
    await waitFor(() => {
      expect(signOut).toHaveBeenCalledTimes(1)
    })
  })

  it('switches to the send tab and shows the mqtt hop on the timeline', () => {
    render(<DiagnosticsSection />)
    fireEvent.click(screen.getByRole('tab', { name: '消息回复' }))
    expect(screen.getByText('broker down')).toBeTruthy()
    expect(screen.getByText('MQTT')).toBeTruthy()
    expect(screen.getByText('outbox_sender.mqtt_publish.failed')).toBeTruthy()
  })
})
