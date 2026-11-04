import { describe, it, expect, vi, beforeEach } from 'vitest'

const capture = vi.fn()
vi.mock('@/lib/telemetry/capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telemetry/capture')>()
  return { ...actual, captureTelemetry: (args: unknown) => capture(args) }
})

import { __resetTelemetryThrottleForTest } from '@/lib/telemetry/capture'
import { reportRuntimeInstallFailure } from '../runtime-install-report'

const CRASH =
  "amuxd install-pi failed: pi install failed (exit status: 1): x\nError: Cannot find module 'y'\nNode.js v24.20.0"

describe('reportRuntimeInstallFailure', () => {
  beforeEach(() => {
    capture.mockClear()
    __resetTelemetryThrottleForTest()
  })

  it('groups by failure class with the cause in extra, not in the message', () => {
    reportRuntimeInstallFailure(CRASH, { attempts: 1, route: 'public-mirror', output: ['a'] })
    expect(capture).toHaveBeenCalledTimes(1)
    const args = capture.mock.calls[0][0]
    expect(args.message).toBe('runtime install failed')
    expect(args.fingerprint).toEqual(['runtime-install-failed', 'node_crash'])
    expect(args.tags).toMatchObject({ failure_kind: 'node_crash', route: 'public-mirror', repeated: 'no' })
    expect(args.extra.headline).toBe("Error: Cannot find module 'y'")
  })

  it('reports a burst of retries of the same failure once', () => {
    reportRuntimeInstallFailure(CRASH, { attempts: 1 })
    reportRuntimeInstallFailure(CRASH, { attempts: 2 })
    reportRuntimeInstallFailure('could not download Node.js 24.20.0 from any source', { attempts: 3 })
    expect(capture).toHaveBeenCalledTimes(2)
  })
})
