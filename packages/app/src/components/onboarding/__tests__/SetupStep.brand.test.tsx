import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// A brand that ships pi. Every build used to open the picker on opencode, so a
// pi brand shipped pi only to the users who noticed the second card — and its
// guided path, which promises no choices at all, installed opencode.
vi.mock('@/lib/config/build-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/build-config')>()),
  localAgent: 'pi',
}))

import { SetupStep, resolveGuidedRuntime } from '../SetupStep'
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
    requirements: [req('amuxd')],
    agentRuntimes: [req('opencode', { title: 'OpenCode' }), req('pi', { title: 'Pi' })],
    listRequirements: vi.fn(async () => {}),
    listAgentRuntimes: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    ...over,
  })
}

describe('SetupStep on a build that targets pi', () => {
  beforeEach(() => {
    localStorage.clear()
    seed()
    useOnboardingStore.getState().reset()
  })

  it('lands the guided path on the build’s runtime, not opencode', async () => {
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(useOnboardingStore.getState().runtime).toBe('pi'))
  })

  it('installs the build’s runtime when the guided path finds it missing', async () => {
    const install = vi.fn(async () => {})
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: null }),
      ],
      install,
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    await vi.waitFor(() => expect(install).toHaveBeenCalledWith('pi'))
  })

  it('does not start the guided Pi install until Node meets Pi’s requirement', async () => {
    const install = vi.fn(async () => {})
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: null, blocker: 'node' }),
      ],
      install,
    })
    render(<SetupStep role="guided" onDone={() => {}} />)

    expect(await screen.findByText('使用 Pi 前请先安装 Node.js 22.19 或更高版本。')).toBeInTheDocument()
    expect(install).not.toHaveBeenCalledWith('pi')
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled()
  })

  it('does not offer the self-select Pi install until Node meets Pi’s requirement', () => {
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: null, blocker: 'node' }),
      ],
    })
    render(<SetupStep role="developer" onDone={() => {}} />)

    expect(screen.getByText('使用 Pi 前请先安装 Node.js 22.19 或更高版本。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安装' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled()
  })

  it('rechecks both Pi views after the user installs Node', async () => {
    const listRequirements = vi.fn(async () => {})
    const listAgentRuntimes = vi.fn(async () => {})
    seed({
      agentRuntimes: [
        req('opencode', { title: 'OpenCode' }),
        req('pi', { title: 'Pi', present: false, version: null, blocker: 'node' }),
      ],
      listRequirements,
      listAgentRuntimes,
    })
    render(<SetupStep role="guided" onDone={() => {}} />)
    listRequirements.mockClear()
    listAgentRuntimes.mockClear()

    screen.getByRole('button', { name: '我已安装 Node.js，重新检测' }).click()
    await vi.waitFor(() => expect(listRequirements).toHaveBeenCalledWith('pi'))
    expect(listAgentRuntimes).toHaveBeenCalledOnce()
  })

  it('opens the developer picker on the build’s runtime', () => {
    render(<SetupStep role="developer" onDone={() => {}} />)
    screen.getByRole('button', { name: '继续' }).click()
    expect(useOnboardingStore.getState().runtime).toBe('pi')
  })

  // The guided path can only land somewhere this app can fetch: cursor and
  // claude-code are the user's own tools, and a guided user has no way to
  // install one from that screen.
  it('falls back to opencode for a build targeting a runtime we cannot install', () => {
    expect(resolveGuidedRuntime('pi')).toBe('pi')
    expect(resolveGuidedRuntime('opencode')).toBe('opencode')
    expect(resolveGuidedRuntime('cursor')).toBe('opencode')
    expect(resolveGuidedRuntime('claude-code')).toBe('opencode')
  })
})
