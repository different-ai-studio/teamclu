import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SetupStep } from '../SetupStep'
import { useSetupStore, type RequirementStatus } from '@/stores/setup'
import { useOnboardingStore } from '@/stores/onboarding'

const req = (id: string, over: Partial<RequirementStatus> = {}): RequirementStatus => ({
  id,
  title: id,
  optional: false,
  present: true,
  version: '1.0.0',
  ...over,
})

function seed(over: Partial<ReturnType<typeof useSetupStore.getState>> = {}) {
  useSetupStore.setState({
    loaded: true,
    installing: null,
    errors: {},
    output: {},
    progress: {},
    installRoute: null,
    requirements: [req('amuxd'), req('git', { optional: true })],
    agentRuntimes: [req('opencode', { title: 'OpenCode' }), req('pi', { title: 'Pi' })],
    listRequirements: vi.fn(async () => {}),
    listAgentRuntimes: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    ...over,
  })
}

describe('SetupStep', () => {
  beforeEach(() => {
    seed()
    useOnboardingStore.getState().reset()
  })

  // "Is it even using the mirror?" is the first thing a slow first run makes
  // people ask, and the answer used to go past in one throwaway progress line.
  it('keeps the download source on screen', () => {
    seed({ installRoute: { id: 'opencode', choice: 'self-hosted' } })
    render(<SetupStep role="guided" onDone={() => {}} />)
    expect(screen.getByText('正在从我们自建的镜像下载')).toBeInTheDocument()
  })

  // The route probe is up to nine seconds of sampling both registries, and its
  // raw line is English prose about routes. Say what it is doing instead.
  it('puts the route probe in words rather than showing amuxd’s line', () => {
    seed({
      installing: 'opencode',
      progress: {
        opencode: {
          event: 'probe',
          message: 'checking which download route is fastest',
          percent: null,
        },
      },
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    expect(screen.getByText('正在确认网络环境，挑更快的下载源…')).toBeInTheDocument()
    expect(
      screen.queryByText('checking which download route is fastest'),
    ).not.toBeInTheDocument()
  })

  it('lets a developer see both runtimes', () => {
    render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('Pi')).toBeInTheDocument()
  })

  // git is optional; only the developer path surfaces it, and even there it
  // must not block continuing.
  it('shows git to developers and hides it from the guided path', () => {
    const { unmount } = render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByText('git')).toBeInTheDocument()
    unmount()

    seed()
    render(<SetupStep role="guided" onDone={() => {}} />)
    expect(screen.queryByText('git')).not.toBeInTheDocument()
  })

  it('does not block on missing git', () => {
    seed({ requirements: [req('amuxd'), req('git', { optional: true, present: false, version: null })] })
    render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled()
  })

  // The guided path promises no choices, so it has to land somewhere
  // predictable. Adopting whatever was already installed made the outcome depend
  // on the machine's history: anyone who had ever installed Pi got it.
  it('always lands on OpenCode for the guided path, even with another runtime installed', async () => {
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi' }),
      ],
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(useOnboardingStore.getState().runtime).toBe('opencode'))
  })

  // Landing on OpenCode and then stopping at "install it yourself" would be the same
  // dead end the guided path exists to avoid.
  it('installs OpenCode itself when the guided path finds it missing', async () => {
    const install = vi.fn(async () => {})
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode', present: false, version: null }),
        req('pi', { title: 'Pi' }),
      ],
      install,
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(install).toHaveBeenCalledWith('opencode'))
  })

  // Nothing on the guided screen is user-initiated, so a failed auto-install has
  // no other way to reach the user.
  it('surfaces a runtime install failure on the guided path', () => {
    seed({
      agentRuntimes: [req('opencode', { title: 'OpenCode' }), req('pi', { title: 'Pi' })],
      errors: { opencode: 'opencode install boom' },
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    expect(screen.getByText('opencode install boom')).toBeInTheDocument()
  })

  // `present: false` with a version means installed-but-outdated. The store's
  // contract is that the wizard still offers the upgrade and stops blocking;
  // the card used to show the version and swallow the action entirely.
  it('offers an upgrade for a runtime that is installed but out of date', () => {
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: '0.1.0' }),
      ],
    })
    render(<SetupStep role="developer" onDone={() => {}} />)

    expect(screen.getByText('0.1.0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '升级' })).toBeInTheDocument()
    // Outdated is not a blocker — the selected runtime is still usable.
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled()
  })

  // Cursor's doctor `satisfied` folds in an API key, and the key is entered in
  // Settings — which only exists after onboarding. Gating the card on it made
  // the option invisible to everyone, with no explanation.
  it('offers Cursor when it is installed but still missing its API key', () => {
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('cursor', { title: 'Cursor', optional: true, version: null, blocker: 'api_key' }),
      ],
    })
    render(<SetupStep role="developer" onDone={() => {}} />)

    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText(/缺 API Key/)).toBeInTheDocument()
    // Installed, so it is a real choice — not an Install action the app cannot
    // perform, and not a disabled card either.
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    screen.getByText('Cursor').click()
    expect(useOnboardingStore.getState().runtime).toBe('cursor')
  })

  it('blocks continuing until amuxd is present', () => {
    seed({ requirements: [req('amuxd', { present: false, version: null })] })
    render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByRole('button', { name: /继续|正在配置/ })).toBeDisabled()
  })

  it('offers the guided user a way back to choosing a runtime', () => {
    render(<SetupStep role="guided" onDone={() => {}} />)
    screen.getByText('我想自己选运行时').click()
    expect(useOnboardingStore.getState().role).toBe('developer')
  })

  // The probe behind `loaded` shells out to `amuxd doctor`. It used to render as
  // a bare spinner — the same picture a hung app draws.
  it('says it is scanning while the runtime probe is still running', () => {
    seed({ loaded: false })
    render(<SetupStep role="guided" onDone={() => {}} />)
    expect(screen.getByText('正在扫描本机已安装的 agent…')).toBeInTheDocument()
  })

  // `loaded` covers the requirements probe only; the runtime scan is a second
  // call, and its empty result used to render as an empty grid.
  it('says it is scanning while the runtime list is still empty', () => {
    seed({ agentRuntimes: [] })
    render(<SetupStep role="developer" onDone={() => {}} />)
    expect(screen.getByText('正在扫描本机已安装的 agent…')).toBeInTheDocument()
  })

  // A multi-minute download behind a static "安装中…" is indistinguishable from
  // a hang; the line names what is being fetched and the bar says how far in.
  it('shows the download and its percentage while a runtime installs', () => {
    seed({
      installing: 'opencode',
      agentRuntimes: [
        req('opencode', { title: 'OpenCode', present: false, version: null }),
        req('pi', { title: 'Pi' }),
      ],
      progress: {
        opencode: {
          event: 'download',
          message: 'downloading https://example.test/opencode.zip',
          percent: 42,
        },
      },
    })
    render(<SetupStep role="developer" onDone={() => {}} />)

    expect(screen.getByText('downloading https://example.test/opencode.zip')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
  })

  // The guided path installs on its own, so its single row is where progress has
  // to land.
  it('shows install progress on the guided path', () => {
    seed({
      installing: 'opencode',
      agentRuntimes: [req('opencode', { title: 'OpenCode', present: false, version: null })],
      progress: { opencode: { event: 'unpack', message: 'unpacking opencode', percent: null } },
    })
    render(<SetupStep role="guided" onDone={() => {}} />)

    expect(screen.getByText('unpacking opencode')).toBeInTheDocument()
    // No measurable size — a sweep, not a fill frozen at 0%.
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })
})
