import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => 'test-host') }))

import { DaemonOnboardingWizard } from '../DaemonOnboardingWizard'
import { useDaemonOnboardingStore } from '@/stores/daemon-onboarding'

const noop = async () => {}

function seed(over: Record<string, unknown> = {}) {
  useDaemonOnboardingStore.setState({
    status: 'starting',
    loaded: true,
    busy: false,
    error: null,
    ownedAgents: [],
    cloudAuthExpired: false,
    healing: false,
    healError: null,
    step: null,
    completedSteps: [],
    failedStep: null,
    daemonOutdated: false,
    runtimeInstallFailures: 0,
    runStartedAt: null,
    completedAgent: null,
    refresh: noop,
    loadOwnedAgents: noop,
    createNewAgent: noop,
    bindExistingAgent: noop,
    forceReset: noop,
    checkCloudSession: noop,
    autoHealCloudSession: noop,
    retryRuntimeInstall: noop,
    ...over,
  })
}

describe('DaemonOnboardingWizard', () => {
  beforeEach(() => seed())
  afterEach(() => vi.useRealTimers())

  // The unit env runs zh-CN per project convention.
  it('shows the individual operations instead of one opaque spinner', () => {
    seed({ step: 'init-daemon', completedSteps: ['mint-invite'] })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.getByText('申请凭证')).toBeInTheDocument()
    expect(screen.getByText('写入本地配置')).toBeInTheDocument()
    expect(screen.getByText('等待服务就绪')).toBeInTheDocument()
  })

  it('surfaces elapsed time only once a run is genuinely slow', () => {
    vi.useFakeTimers()
    seed({ step: 'await-daemon', runStartedAt: Date.now() })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.queryByText(/仍在进行/)).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(9000)
    })
    expect(screen.getByText(/仍在进行/)).toBeInTheDocument()
  })

  // The screen in the report: restart is checked, await-daemon failed, and a
  // cloud-auth read that resolved late is still sitting in `completedSteps`.
  // That later check must not render — the service never became ready.
  it('does not check a step that comes after the one that failed', () => {
    seed({
      status: 'error',
      failedStep: 'await-daemon',
      completedSteps: ['restart-daemon', 'cloud-auth'],
      error: '本地 daemon 启动失败：请确认本机可运行后重试。',
    })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.getByText(/卡在这一步：等待服务就绪/)).toBeInTheDocument()
    expect(screen.getByText('重启本地服务').className).toContain('text-muted-foreground')
    expect(screen.getByText('等待服务就绪').className).toContain('text-coral')
    expect(screen.getByText('检查云端连接').className).toContain('text-faint')
    expect(screen.getByText('检查云端连接').className).not.toContain('text-muted-foreground')
  })

  it('does not say the service never answered when it rejected the credential', () => {
    seed({
      status: 'error',
      failedStep: 'await-daemon',
      completedSteps: ['restart-daemon'],
      error:
        '本地 daemon 已在运行，但没有接受这台机器的凭证。重试会重启它；若仍然失败，请重置并重新初始化。',
    })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.queryByText(/一直没响应/)).not.toBeInTheDocument()
    expect(screen.getByText(/拒绝了这台机器的凭证/)).toBeInTheDocument()
  })

  it('names the failed step and offers a reset when credentials may be half-written', () => {
    seed({ status: 'error', failedStep: 'init-daemon', completedSteps: ['mint-invite'], error: 'boom' })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.getByText(/卡在这一步：写入本地配置/)).toBeInTheDocument()
    expect(screen.getByText('重置并重新初始化')).toBeInTheDocument()
  })

  // The step that fails is still `install-runtime`, but its recovery copy is
  // about downloads and mirrors — and the network is the one thing that is not
  // wrong here. Reported as "check your network, then retry" over a daemon that
  // could not have answered either way.
  it('does not blame the network when the daemon is the one too old to answer', () => {
    seed({
      status: 'error',
      failedStep: 'install-runtime',
      daemonOutdated: true,
      error: '本机 daemon（amuxd 0.4.1-beta.40）比这个应用（0.4.1-beta.44）旧',
    })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.queryByText(/检查网络/)).not.toBeInTheDocument()
    expect(screen.getByText(/比应用旧，报不出运行时状态/)).toBeInTheDocument()
    expect(screen.getByText(/0\.4\.1-beta\.40/)).toBeInTheDocument()
  })

  // 2026-11-04: a Node crash ends on its version footer, and that footer was
  // the only thing a stuck user could see or send us.
  const NODE_CRASH =
    "amuxd install-pi failed: pi install failed (exit status: 1): node:internal/modules/cjs/loader:1386\n" +
    "Error: Cannot find module '/x/npm-cli.js'\n    at Function._resolveFilename (node:internal)\n\nNode.js v24.20.0"

  it('leads a failed install with its cause and keeps the trace behind a toggle', () => {
    seed({ status: 'error', failedStep: 'install-runtime', error: NODE_CRASH, runtimeInstallFailures: 1 })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.getByText("Error: Cannot find module '/x/npm-cli.js'")).toBeInTheDocument()
    expect(screen.queryByText(/Node\.js v24\.20\.0/)).not.toBeInTheDocument()
    expect(screen.getByText(/完整日志：.*logs\/install-pi\.log/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制详情' })).toBeInTheDocument()
    // One failure: Retry is still the right advice.
    expect(screen.queryByRole('button', { name: '重启应用' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '显示详情' }))
    expect(screen.getByText(/Node\.js v24\.20\.0/)).toBeInTheDocument()
  })

  it('offers a restart once installs keep failing', () => {
    vi.mocked(invoke).mockClear()
    seed({ status: 'error', failedStep: 'install-runtime', error: NODE_CRASH, runtimeInstallFailures: 2 })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.getByText(/已经连续失败 2 次/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重启应用' }))
    return vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_app'))
  })

  it('does not offer a restart for a daemon too old to answer', () => {
    seed({
      status: 'error',
      failedStep: 'install-runtime',
      daemonOutdated: true,
      error: 'stale',
      runtimeInstallFailures: 5,
    })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.queryByRole('button', { name: '重启应用' })).not.toBeInTheDocument()
  })

  // AuthGate mounts the wizard whenever the status turns 'starting' or 'error'.
  // A refresh on that mount marked a healthy daemon 'ready' over the failure,
  // AuthGate unmounted the wizard, the post-ready check reinstalled, failed,
  // and remounted it — every few seconds, error on screen for an instant.
  it.each(['starting', 'error'] as const)(
    'mounting on %s reports the work in flight instead of starting a refresh',
    (status) => {
      const refresh = vi.fn(noop)
      seed({ status, failedStep: status === 'error' ? 'install-runtime' : null, error: 'x', refresh })
      render(<DaemonOnboardingWizard onDone={() => {}} />)
      expect(refresh).not.toHaveBeenCalled()
    },
  )

  it.each(['unknown', 'needs-onboard', 'mismatch'] as const)('mounting on %s starts the work', (status) => {
    const refresh = vi.fn(noop)
    seed({ status, refresh })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('retries a failed runtime install in place rather than through refresh', () => {
    const refresh = vi.fn(noop)
    const retryRuntimeInstall = vi.fn(noop)
    seed({ status: 'error', failedStep: 'install-runtime', error: 'boom', refresh, retryRuntimeInstall })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(retryRuntimeInstall).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('offers reconnect rather than retry when cloud auth is what failed', () => {
    seed({ status: 'error', failedStep: 'cloud-auth', error: 'boom' })
    render(<DaemonOnboardingWizard onDone={() => {}} />)
    expect(screen.getByRole('button', { name: '重新连接' })).toBeInTheDocument()
  })

  it('confirms what was set up before handing off', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    seed({ status: 'ready', completedAgent: { agentId: 'a1', displayName: 'Mac mini' } })
    render(<DaemonOnboardingWizard onDone={onDone} />)
    expect(screen.getByText(/Mac mini/)).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1600)
    })
    expect(onDone).toHaveBeenCalled()
  })

  // Cold-start recovery is not something the user asked for; it must not add a
  // confirmation screen to every launch that needed a daemon restart.
  it('hands off immediately when the user did nothing', () => {
    const onDone = vi.fn()
    seed({ status: 'ready', completedAgent: null })
    render(<DaemonOnboardingWizard onDone={onDone} />)
    expect(onDone).toHaveBeenCalled()
  })
})
