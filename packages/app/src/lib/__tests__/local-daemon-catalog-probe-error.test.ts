import { describe, test, expect, vi, beforeEach } from 'vitest'

const getDaemonModelCatalog = vi.hoisted(() => vi.fn())

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  getDaemonModelCatalog,
  encodeWorkspaceId: (p: string) => p,
}))

import { fetchLocalDaemonCatalog } from '@/lib/agent/local-daemon-model-catalog'

const WS = '/Users/me/TeamClu Dev'

describe('fetchLocalDaemonCatalog — a daemon that cannot start its backend', () => {
  beforeEach(() => getDaemonModelCatalog.mockReset())

  test('reports the probe error when there is no backend group at all', async () => {
    // The exact shape a missing runtime binary produces: HTTP 200, no groups,
    // and the reason in `probe_error`. Returning `unknown` here is what left
    // the agent pill spinning at "connecting" indefinitely.
    getDaemonModelCatalog.mockResolvedValue({
      automation_default_backend: null,
      backends: [],
      probe_error:
        'agent error: agent_binary_missing(opencode): spawn opencode serve (opencode): No such file or directory (os error 2)',
    })

    const outcome = await fetchLocalDaemonCatalog(WS)

    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(outcome.message).toContain('agent_binary_missing(opencode)')
    }
  })

  test('names the backend the daemon meant to use, when it named one', async () => {
    getDaemonModelCatalog.mockResolvedValue({
      automation_default_backend: 'pi',
      backends: [],
      probe_error: 'pi: connection refused',
    })

    const outcome = await fetchLocalDaemonCatalog(WS)

    expect(outcome).toMatchObject({ status: 'error', backend: 'pi' })
  })

  test('still says unknown when the daemon offers no explanation', async () => {
    // No groups and no error is genuinely "no information" — the caller must
    // keep waiting rather than paint a failure it cannot describe.
    getDaemonModelCatalog.mockResolvedValue({
      automation_default_backend: null,
      backends: [],
    })

    expect(await fetchLocalDaemonCatalog(WS)).toEqual({ status: 'unknown' })
  })

  test('an unreachable daemon is still unknown, not an error', async () => {
    getDaemonModelCatalog.mockResolvedValue(null)

    expect(await fetchLocalDaemonCatalog(WS)).toEqual({ status: 'unknown' })
  })
})
