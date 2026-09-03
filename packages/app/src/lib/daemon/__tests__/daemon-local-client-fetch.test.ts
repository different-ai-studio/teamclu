import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:1111',
  fetchCalls: 0,
  failFirstMcpGet: false,
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'get_daemon_http_info') {
      return { base_url: h.baseUrl, root_token: 'root-xyz' }
    }
    return null
  }),
}))

import { getDaemonMcp, invalidateDaemonConnection } from '@/lib/daemon/daemon-local-client'

beforeEach(() => {
  h.baseUrl = 'http://127.0.0.1:1111'
  h.fetchCalls = 0
  h.failFirstMcpGet = false
  invalidateDaemonConnection()

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      h.fetchCalls += 1
      const u = String(url)

      if (u.endsWith('/v1/auth/exchange')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'sess-123', expires_in: 3600 }),
        } as unknown as Response
      }

      if (u.includes('/v1/workspaces/') && u.endsWith('/mcp')) {
        if (h.failFirstMcpGet) {
          h.failFirstMcpGet = false
          throw new Error('Load failed (127.0.0.1:1111)')
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ playwright: { type: 'local', enabled: false } }),
        } as unknown as Response
      }

      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('daemon-local-client fetch resilience', () => {
  it('retries once after a transient network failure', async () => {
    h.failFirstMcpGet = true
    const servers = await getDaemonMcp('ws-id')
    expect(servers.playwright).toBeDefined()
    expect(h.fetchCalls).toBeGreaterThan(2)
  })

  it('drops cached connection when daemon port changes', async () => {
    await getDaemonMcp('ws-id')
    const callsAfterFirst = h.fetchCalls

    h.baseUrl = 'http://127.0.0.1:2222'
    await getDaemonMcp('ws-id')

    const exchangeCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).endsWith('/v1/auth/exchange'),
    )
    expect(exchangeCalls.some((c) => String(c[0]).startsWith('http://127.0.0.1:2222'))).toBe(true)
    expect(h.fetchCalls).toBeGreaterThan(callsAfterFirst)
  })
})
