import { afterEach, describe, expect, it, vi } from 'vitest'

describe('isAgentReplyForkEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.doUnmock('@/lib/config/build-config')
  })

  it('is true outside extension embed builds even when the flag is off', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', undefined)
    vi.doMock('@/lib/config/build-config', () => ({
      extensionAgentReplyForkEnabled: false,
    }))
    const { isAgentReplyForkEnabled } = await import('@/lib/config/agent-reply-fork-build')
    expect(isAgentReplyForkEnabled()).toBe(true)
  })

  it('follows extensions.agentReplyFork in extension embed builds', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', 'chat')
    vi.doMock('@/lib/config/build-config', () => ({
      extensionAgentReplyForkEnabled: false,
    }))
    const { isAgentReplyForkEnabled } = await import('@/lib/config/agent-reply-fork-build')
    expect(isAgentReplyForkEnabled()).toBe(false)
  })

  it('defaults to enabled in extension embed when the flag is on', async () => {
    vi.stubEnv('VITE_FORCE_EMBED', 'chat')
    vi.doMock('@/lib/config/build-config', () => ({
      extensionAgentReplyForkEnabled: true,
    }))
    const { isAgentReplyForkEnabled } = await import('@/lib/config/agent-reply-fork-build')
    expect(isAgentReplyForkEnabled()).toBe(true)
  })
})
