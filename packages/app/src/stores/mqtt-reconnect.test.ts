import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useMqttReconnectStore,
  isMqttAuthFailure,
  shouldAutoRecoverMqttAfterVisibility,
  MQTT_SLEEP_WAKE_HIDDEN_MS,
  recoverMqttConnection,
  resetMqttReconnectRecovery,
  __resetMqttReconnectForTests,
  __markAuthRecoveryForTests,
  BROWSER_RECONNECT_GRACE_MS,
  daemonMqttNeedsRecovery,
} from './mqtt-reconnect'

vi.mock('@/lib/auth/session-store', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}))

/**
 * Hoisted mocks for the browser ensureWired path.
 *
 * `vi.doMock` + `vi.resetModules()` + dynamic `import()` is flaky on CI: the
 * real `@/lib/mqtt/mqtt-browser-bridge` sometimes wins the race, `stateHandler`
 * stays null, and `waitFor(bridge subscribed)` times out. Hoisted `vi.mock`
 * is applied before any import, so the dynamic import in `ensureWired` always
 * hits the stub.
 */
const browserBridgeHandlers = vi.hoisted(() => {
  const handlers: {
    stateHandler: ((state: 'connecting' | 'connected' | 'disconnected') => void) | null
    errorHandler: ((message: string) => void) | null
  } = {
    stateHandler: null,
    errorHandler: null,
  }
  return handlers
})

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>()
  return {
    ...actual,
    isTauri: () => false,
  }
})

vi.mock('@/lib/mqtt/mqtt-browser-bridge', () => ({
  subscribeBrowserMqttState: (
    h: (s: 'connecting' | 'connected' | 'disconnected') => void,
  ) => {
    browserBridgeHandlers.stateHandler = h
    return () => {
      browserBridgeHandlers.stateHandler = null
    }
  },
  subscribeBrowserMqttError: (h: (msg: string) => void) => {
    browserBridgeHandlers.errorHandler = h
    return () => {
      browserBridgeHandlers.errorHandler = null
    }
  },
}))

describe('useMqttReconnectStore', () => {
  beforeEach(() => {
    __resetMqttReconnectForTests()
  })

  it('bump increments the reconnect nonce', () => {
    useMqttReconnectStore.getState().bump()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)
  })

  it('setError records the latest broker error', () => {
    useMqttReconnectStore.getState().setError('broker refused connection: BadUserNamePassword')
    expect(useMqttReconnectStore.getState().lastError).toBe(
      'broker refused connection: BadUserNamePassword',
    )
  })

  it('bump clears a stale error so the reconnect attempt starts clean', () => {
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().bump()
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setError(null) clears the error after a successful connect', () => {
    useMqttReconnectStore.getState().setError('connection timed out')
    useMqttReconnectStore.getState().setError(null)
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setConnected updates the shared connection state', () => {
    useMqttReconnectStore.getState().setConnected(false)
    expect(useMqttReconnectStore.getState().connected).toBe(false)
    useMqttReconnectStore.getState().setConnected(true)
    expect(useMqttReconnectStore.getState().connected).toBe(true)
  })

  it('setConnected(true) clears a stale error (a successful connect is healthy)', () => {
    useMqttReconnectStore.getState().setError('broker refused connection: BadUserNamePassword')
    useMqttReconnectStore.getState().setConnected(true)
    expect(useMqttReconnectStore.getState().connected).toBe(true)
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })

  it('setConnected(false) preserves the error so the reason stays visible', () => {
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().setConnected(false)
    expect(useMqttReconnectStore.getState().connected).toBe(false)
    expect(useMqttReconnectStore.getState().lastError).toBe('connection refused')
  })
})

describe('isMqttAuthFailure', () => {
  it('detects CONNACK auth rejection from the desktop client', () => {
    expect(isMqttAuthFailure('broker refused connection: BadUserNamePassword')).toBe(true)
    expect(isMqttAuthFailure('broker refused connection: NotAuthorized')).toBe(true)
  })

  it('detects event-loop auth rejection messages', () => {
    expect(isMqttAuthFailure('Connection refused, return code: `BadUserNamePassword`')).toBe(true)
    expect(isMqttAuthFailure('Connection refused: bad_username_or_password')).toBe(true)
  })

  it('rejects non-auth broker errors and vague strings', () => {
    expect(isMqttAuthFailure('Operation timed out')).toBe(false)
    expect(isMqttAuthFailure('broker refused connection: ServerUnavailable')).toBe(false)
    expect(isMqttAuthFailure('bad username or password')).toBe(false)
  })
})

describe('shouldAutoRecoverMqttAfterVisibility', () => {
  it('treats long hidden duration as sleep/wake', () => {
    expect(
      shouldAutoRecoverMqttAfterVisibility({
        wasDiscarded: false,
        hiddenMs: MQTT_SLEEP_WAKE_HIDDEN_MS,
      }),
    ).toBe(true)
  })

  it('treats discarded documents as sleep/wake', () => {
    expect(
      shouldAutoRecoverMqttAfterVisibility({ wasDiscarded: true, hiddenMs: 0 }),
    ).toBe(true)
  })

  it('skips session refresh on short tab switches', () => {
    expect(
      shouldAutoRecoverMqttAfterVisibility({
        wasDiscarded: false,
        hiddenMs: MQTT_SLEEP_WAKE_HIDDEN_MS - 1,
      }),
    ).toBe(false)
  })
})

describe('daemonMqttNeedsRecovery', () => {
  it('trusts a coherent daemon Ready snapshot over a stale app-side false', () => {
    expect(daemonMqttNeedsRecovery({ connected: true, phase: 'Ready' }, false)).toBe(false)
  })

  it('requests recovery for a non-ready daemon snapshot', () => {
    expect(daemonMqttNeedsRecovery({ connected: false, phase: 'Recovering' }, true)).toBe(true)
    expect(daemonMqttNeedsRecovery({ connected: false, phase: 'Backoff' }, null)).toBe(true)
  })

  it('does not recover a deliberately stopped daemon', () => {
    expect(daemonMqttNeedsRecovery({ connected: false, phase: 'Stopped' }, false)).toBe(false)
  })

  it('falls back to the app-side status when the daemon snapshot is unavailable', () => {
    expect(daemonMqttNeedsRecovery(null, true)).toBe(false)
    expect(daemonMqttNeedsRecovery(null, false)).toBe(true)
  })
})

describe('recoverMqttConnection', () => {
  beforeEach(async () => {
    __resetMqttReconnectForTests()
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
  })

  it('bypasses automatic recovery cooldown for explicit user retries', async () => {
    __markAuthRecoveryForTests()
    await recoverMqttConnection()
    const { refreshSession } = await import('@/lib/auth/session-store')
    expect(refreshSession).toHaveBeenCalledOnce()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)
  })
})

describe('resetMqttReconnectRecovery', () => {
  beforeEach(async () => {
    __resetMqttReconnectForTests()
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
  })

  it('clears connected, error, and nonce on sign-out', () => {
    useMqttReconnectStore.getState().setConnected(false)
    useMqttReconnectStore.getState().setError('connection refused')
    useMqttReconnectStore.getState().bump()
    resetMqttReconnectRecovery()
    expect(useMqttReconnectStore.getState()).toMatchObject({
      nonce: 0,
      connected: null,
      lastError: null,
    })
  })

  it('aborts bump when reset runs during in-flight refresh', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    let resolveRefresh!: () => void
    const refreshDeferred = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    vi.mocked(refreshSession).mockReturnValue(refreshDeferred)

    const recovery = recoverMqttConnection()
    await Promise.resolve()
    resetMqttReconnectRecovery()
    resolveRefresh()
    await recovery

    expect(useMqttReconnectStore.getState().nonce).toBe(0)
  })
})

/**
 * Poll until `check()` holds. `ensureWired()` reaches the bridge through
 * dynamic imports, so the subscription lands a few microtasks later.
 * Must only be used on real timers.
 */
async function waitFor(check: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`waitFor(${label}): condition still false after ${timeoutMs}ms`)
}

describe('useMqttReconnectStore — ensureWired browser path', () => {
  beforeEach(async () => {
    browserBridgeHandlers.stateHandler = null
    browserBridgeHandlers.errorHandler = null
    __resetMqttReconnectForTests()
    useMqttReconnectStore.setState({ nonce: 0, lastError: null, connected: null, _wired: false })
    const { refreshSession } = await import('@/lib/auth/session-store')
    vi.mocked(refreshSession).mockClear()
  })

  it('ensureWired in browser path subscribes to state and error from bridge', async () => {
    useMqttReconnectStore.getState().ensureWired()

    await waitFor(
      () =>
        browserBridgeHandlers.stateHandler !== null &&
        browserBridgeHandlers.errorHandler !== null,
      'bridge subscribed',
    )

    const { stateHandler, errorHandler } = browserBridgeHandlers
    expect(stateHandler).not.toBeNull()
    expect(errorHandler).not.toBeNull()

    stateHandler!('disconnected')
    expect(useMqttReconnectStore.getState().connected).toBe(false)

    stateHandler!('connected')
    expect(useMqttReconnectStore.getState().connected).toBe(true)

    stateHandler!('connecting')
    expect(useMqttReconnectStore.getState().connected).toBeNull()

    errorHandler!('broker auth failure')
    expect(useMqttReconnectStore.getState().lastError).toBe('broker auth failure')
  })

  it('refreshes credentials and bumps reconnect when a browser MQTT disconnect outlasts the grace window', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    useMqttReconnectStore.getState().ensureWired()
    await waitFor(() => browserBridgeHandlers.stateHandler !== null, 'bridge subscribed')

    vi.useFakeTimers()
    try {
      browserBridgeHandlers.stateHandler!('disconnected')
      // Inside the grace window mqtt.js auto-reconnect owns recovery.
      await vi.advanceTimersByTimeAsync(BROWSER_RECONNECT_GRACE_MS - 1000)
      expect(refreshSession).not.toHaveBeenCalled()
      // Still down once the grace window elapses -> escalate.
      await vi.advanceTimersByTimeAsync(2000)
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => vi.mocked(refreshSession).mock.calls.length > 0, 'refreshSession called')

    expect(refreshSession).toHaveBeenCalledOnce()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)
  })

  it('does not refresh credentials when auto-reconnect restores within the grace window', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    useMqttReconnectStore.getState().ensureWired()
    await waitFor(() => browserBridgeHandlers.stateHandler !== null, 'bridge subscribed')

    vi.useFakeTimers()
    try {
      browserBridgeHandlers.stateHandler!('disconnected')
      await vi.advanceTimersByTimeAsync(3000)
      browserBridgeHandlers.stateHandler!('connected')
      await vi.advanceTimersByTimeAsync(BROWSER_RECONNECT_GRACE_MS * 2)
    } finally {
      vi.useRealTimers()
    }
    // Negative assertion: there is no condition to poll for, and waiting longer
    // than necessary only makes a false pass less likely, never a false fail.
    await new Promise((r) => setTimeout(r, 20))

    expect(refreshSession).not.toHaveBeenCalled()
    expect(useMqttReconnectStore.getState().nonce).toBe(0)
  })

  it('refreshes credentials and bumps reconnect on browser MQTT auth failure', async () => {
    const { refreshSession } = await import('@/lib/auth/session-store')
    useMqttReconnectStore.getState().ensureWired()

    await waitFor(() => browserBridgeHandlers.errorHandler !== null, 'bridge subscribed')
    browserBridgeHandlers.errorHandler!('Connection refused: bad_username_or_password')
    expect(useMqttReconnectStore.getState().lastError).toBe(
      'Connection refused: bad_username_or_password',
    )
    await waitFor(() => vi.mocked(refreshSession).mock.calls.length > 0, 'refreshSession called')

    expect(refreshSession).toHaveBeenCalledOnce()
    expect(useMqttReconnectStore.getState().nonce).toBe(1)
    expect(useMqttReconnectStore.getState().lastError).toBeNull()
  })
})
