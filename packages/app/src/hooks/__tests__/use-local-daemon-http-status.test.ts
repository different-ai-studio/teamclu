import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { resolveLocalDaemonRuntimeStatus, useLocalDaemonHttpStatus } from '../use-local-daemon-http-status'

const mocks = vi.hoisted(() => ({
  daemonReady: true,
  probeDaemonHttp: vi.fn(),
}))

const originalDocumentHidden = Object.getOwnPropertyDescriptor(document, 'hidden')

vi.mock('@/stores/daemon-onboarding', () => ({
  useDaemonOnboardingStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: mocks.daemonReady ? 'ready' : 'starting' }),
}))

vi.mock('@/stores/daemon-mqtt-status', () => ({
  useDaemonMqttConnected: () => true,
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  probeDaemonHttp: mocks.probeDaemonHttp,
}))

vi.mock('@/lib/agent/agent-device-reachability', () => ({
  noteLocalDaemonSignals: vi.fn(),
}))

describe('resolveLocalDaemonRuntimeStatus', () => {
  it('returns offline when onboarding is not ready', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: false,
        httpStatus: 'online',
        daemonMqttConnected: true,
      }),
    ).toBe('offline')
  })

  it('returns offline when http probe fails', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'offline',
        daemonMqttConnected: true,
      }),
    ).toBe('offline')
  })

  it('returns online when the daemon is reachable and its mqtt link is up', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        daemonMqttConnected: true,
      }),
    ).toBe('online')
  })

  it('returns daemonMqttDisconnected when the daemon is up but its mqtt link is down', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        daemonMqttConnected: false,
      }),
    ).toBe('daemonMqttDisconnected')
  })

  it('stays checking while the http probe is in flight', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'checking',
        daemonMqttConnected: false,
      }),
    ).toBe('checking')
  })

  it('stays checking when http is online but the daemon mqtt probe is pending', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'online',
        daemonMqttConnected: null,
      }),
    ).toBe('checking')
  })

  it('stays checking before the first probe runs', () => {
    expect(
      resolveLocalDaemonRuntimeStatus({
        daemonOnboardingReady: true,
        httpStatus: 'idle',
        daemonMqttConnected: null,
      }),
    ).toBe('checking')
  })
})

describe('useLocalDaemonHttpStatus', () => {
  beforeEach(() => {
    mocks.daemonReady = true
    mocks.probeDaemonHttp.mockReset().mockResolvedValue({ ok: true, baseUrl: 'http://127.0.0.1' })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalDocumentHidden) {
      Object.defineProperty(document, 'hidden', originalDocumentHidden)
    }
  })

  it('re-probes when the window regains focus', async () => {
    const { unmount } = renderHook(() => useLocalDaemonHttpStatus())

    await waitFor(() => expect(mocks.probeDaemonHttp).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(mocks.probeDaemonHttp).toHaveBeenCalledTimes(2)
    unmount()

    window.dispatchEvent(new Event('focus'))
    expect(mocks.probeDaemonHttp).toHaveBeenCalledTimes(2)
  })

  it('re-probes when the document becomes visible, but ignores hidden events', async () => {
    let hidden = true
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    })

    const { unmount } = renderHook(() => useLocalDaemonHttpStatus())
    await waitFor(() => expect(mocks.probeDaemonHttp).toHaveBeenCalledTimes(1))

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mocks.probeDaemonHttp).toHaveBeenCalledTimes(1)

    hidden = false
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mocks.probeDaemonHttp).toHaveBeenCalledTimes(2)
    unmount()
  })
})
