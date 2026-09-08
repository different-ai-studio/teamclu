import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

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
    runStartedAt: null,
    completedAgent: null,
    refresh: noop,
    loadOwnedAgents: noop,
    createNewAgent: noop,
    bindExistingAgent: noop,
    forceReset: noop,
    checkCloudSession: noop,
    autoHealCloudSession: noop,
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
