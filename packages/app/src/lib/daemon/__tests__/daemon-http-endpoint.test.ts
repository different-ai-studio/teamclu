import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  isTauriVal: true,
  // What `get_daemon_http_info` answers: the pair, or null when the daemon is
  // down and its run-dir files are gone.
  info: { base_url: 'http://127.0.0.1:60243', root_token: 'root-xyz' } as
    | { base_url: string; root_token: string }
    | null,
  opened: [] as string[],
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => h.isTauriVal,
  openExternalUrl: vi.fn(async (url: string) => {
    h.opened.push(url)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === 'get_daemon_http_info' ? h.info : null)),
}))

import {
  getDaemonHttpEndpoint,
  openDaemonSetupConsole,
} from '@/lib/daemon/daemon-local-client'

beforeEach(() => {
  h.isTauriVal = true
  h.info = { base_url: 'http://127.0.0.1:60243', root_token: 'root-xyz' }
  h.opened = []
})

describe('daemon HTTP endpoint', () => {
  // amuxd binds `127.0.0.1:0`, so this number is different on every restart and
  // is written nowhere a user would look. Showing it is the whole point.
  it('reports the base URL and the port parsed out of it', async () => {
    expect(await getDaemonHttpEndpoint()).toEqual({
      baseUrl: 'http://127.0.0.1:60243',
      port: 60243,
    })
  })

  it('still reports the address when the URL carries no port', async () => {
    h.info = { base_url: 'http://localhost', root_token: 'root-xyz' }
    expect(await getDaemonHttpEndpoint()).toEqual({
      baseUrl: 'http://localhost',
      port: null,
    })
  })

  it('does not hand back the root token that arrives beside the URL', async () => {
    // This feeds a settings row; a token on screen is a token in a screenshot.
    const endpoint = await getDaemonHttpEndpoint()
    expect(JSON.stringify(endpoint)).not.toContain('root-xyz')
  })

  it('answers null when the daemon is not running', async () => {
    h.info = null
    expect(await getDaemonHttpEndpoint()).toBeNull()
  })
})

describe('web config console', () => {
  it('opens the same URL `amuxd setup` prints', async () => {
    expect(await openDaemonSetupConsole()).toBe(true)
    expect(h.opened).toEqual([
      'http://127.0.0.1:60243/v1/setup?access_token=root-xyz',
    ])
  })

  it('percent-encodes a token that is not URL-safe', async () => {
    h.info = { base_url: 'http://127.0.0.1:60243', root_token: 'a+b/c=d' }
    await openDaemonSetupConsole()
    expect(h.opened[0]).toBe(
      'http://127.0.0.1:60243/v1/setup?access_token=a%2Bb%2Fc%3Dd',
    )
  })

  it('reports failure rather than opening a tokenless console', async () => {
    // No run-dir files means no daemon. `/v1/setup` without the root token
    // renders a page that cannot claim anything — worse than saying so.
    h.info = null
    expect(await openDaemonSetupConsole()).toBe(false)
    expect(h.opened).toEqual([])
  })
})
