import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forgetAppSessionSetups,
  recordAppSessionSetup,
  runAppSessionSetupOnce,
  waitForAppSessionSetup,
} from '@/lib/apps/app-session-setup'

/** The registry is module state shared across tests; every test uses its own ids. */
let seq = 0
const ids = () => {
  seq += 1
  return { appId: `app-${seq}`, sessionId: `session-${seq}` }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runAppSessionSetupOnce', () => {
  it('does the setup once per session once it has landed', async () => {
    const { appId, sessionId } = ids()
    const setup = vi.fn().mockResolvedValue(true)

    await runAppSessionSetupOnce(appId, sessionId, setup)
    await runAppSessionSetupOnce(appId, sessionId, setup)

    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('shares one run between callers that arrive while it is in flight', async () => {
    const { appId, sessionId } = ids()
    const gate = deferred<boolean>()
    const setup = vi.fn(() => gate.promise)

    const first = runAppSessionSetupOnce(appId, sessionId, setup)
    const second = runAppSessionSetupOnce(appId, sessionId, setup)
    gate.resolve(true)
    await Promise.all([first, second])

    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('tries again next time when something did not land', async () => {
    // A daemon that was not up yet, or a seat that failed, must not be
    // remembered as done — otherwise the session never gets it.
    const { appId, sessionId } = ids()
    const setup = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await runAppSessionSetupOnce(appId, sessionId, setup)
    await runAppSessionSetupOnce(appId, sessionId, setup)
    await runAppSessionSetupOnce(appId, sessionId, setup)

    expect(setup).toHaveBeenCalledTimes(2)
  })

  it('passes a failure on and tries again next time', async () => {
    const { appId, sessionId } = ids()
    const setup = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true)

    await expect(runAppSessionSetupOnce(appId, sessionId, setup)).rejects.toThrow('offline')
    await runAppSessionSetupOnce(appId, sessionId, setup)

    expect(setup).toHaveBeenCalledTimes(2)
  })

  it('treats a session recorded at creation as already set up', async () => {
    const { appId, sessionId } = ids()
    recordAppSessionSetup(appId, sessionId)
    const setup = vi.fn().mockResolvedValue(true)

    await runAppSessionSetupOnce(appId, sessionId, setup)

    expect(setup).not.toHaveBeenCalled()
  })
})

describe('waitForAppSessionSetup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns at once for a session nobody is setting up', async () => {
    await expect(waitForAppSessionSetup('never-opened')).resolves.toBeUndefined()
  })

  it('waits for the setup in flight', async () => {
    const { appId, sessionId } = ids()
    const gate = deferred<boolean>()
    void runAppSessionSetupOnce(appId, sessionId, () => gate.promise)

    let waited = false
    const waiting = waitForAppSessionSetup(sessionId).then(() => {
      waited = true
    })
    await Promise.resolve()
    expect(waited).toBe(false)

    gate.resolve(true)
    await waiting
    expect(waited).toBe(true)
  })

  it('does not throw when the setup failed', async () => {
    // The runtime start that waits only needs to know it may go ahead.
    const { appId, sessionId } = ids()
    const gate = deferred<boolean>()
    runAppSessionSetupOnce(appId, sessionId, () => gate.promise).catch(() => {})
    const waiting = waitForAppSessionSetup(sessionId)

    gate.reject(new Error('offline'))
    await expect(waiting).resolves.toBeUndefined()
  })

  it('gives up after the timeout rather than blocking the agent forever', async () => {
    vi.useFakeTimers()
    const { appId, sessionId } = ids()
    void runAppSessionSetupOnce(appId, sessionId, () => new Promise<boolean>(() => {}))

    const waiting = waitForAppSessionSetup(sessionId, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(waiting).resolves.toBeUndefined()
  })
})

describe('forgetAppSessionSetups', () => {
  it("forgets that app's sessions and no other", async () => {
    // A moved checkout invalidates every binding the app's sessions have.
    const moved = ids()
    const other = ids()
    recordAppSessionSetup(moved.appId, moved.sessionId)
    recordAppSessionSetup(other.appId, other.sessionId)

    forgetAppSessionSetups(moved.appId)

    const setupMoved = vi.fn().mockResolvedValue(true)
    const setupOther = vi.fn().mockResolvedValue(true)
    await runAppSessionSetupOnce(moved.appId, moved.sessionId, setupMoved)
    await runAppSessionSetupOnce(other.appId, other.sessionId, setupOther)

    expect(setupMoved).toHaveBeenCalledTimes(1)
    expect(setupOther).not.toHaveBeenCalled()
  })
})
