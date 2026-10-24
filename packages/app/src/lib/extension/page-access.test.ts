import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PAGE_ACCESS_KEY,
  PAGE_ACCESS_REQUEST_TIMEOUT_MS,
  requestAgentPageAccess,
  resolveAgentPageAccess,
  usePageAccessConsentStore,
  writeAgentPageAccessMode,
} from './page-access'

describe('agent page access consent', () => {
  beforeEach(() => {
    localStorage.removeItem(AGENT_PAGE_ACCESS_KEY)
    usePageAccessConsentStore.setState({ pending: null, sessionAllowed: false })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the user and resolves true on "once" without remembering it', async () => {
    const p = requestAgentPageAccess()
    expect(usePageAccessConsentStore.getState().pending).not.toBeNull()
    resolveAgentPageAccess('once')
    await expect(p).resolves.toBe(true)
    expect(usePageAccessConsentStore.getState().sessionAllowed).toBe(false)
  })

  it('remembers "session" for later requests', async () => {
    const p = requestAgentPageAccess()
    resolveAgentPageAccess('session')
    await expect(p).resolves.toBe(true)
    await expect(requestAgentPageAccess()).resolves.toBe(true)
    expect(usePageAccessConsentStore.getState().pending).toBeNull()
  })

  it('resolves false on deny', async () => {
    const p = requestAgentPageAccess()
    resolveAgentPageAccess('deny')
    await expect(p).resolves.toBe(false)
  })

  it('never prompts when page access is switched off', async () => {
    writeAgentPageAccessMode('off')
    await expect(requestAgentPageAccess()).resolves.toBe(false)
    expect(usePageAccessConsentStore.getState().pending).toBeNull()
  })

  it('treats an unanswered request as denied after the timeout', async () => {
    vi.useFakeTimers()
    const p = requestAgentPageAccess()
    vi.advanceTimersByTime(PAGE_ACCESS_REQUEST_TIMEOUT_MS + 1)
    await expect(p).resolves.toBe(false)
  })
})
