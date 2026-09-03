import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  isTauriVal: true,
  // get_daemon_http_info behaviour: 'ok' | 'null' | 'throw'
  infoMode: 'ok' as 'ok' | 'null' | 'throw',
  // fetch behaviour per endpoint
  healthzOk: true,
  healthzThrows: false,
  exchangeOk: true,
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => h.isTauriVal }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'get_daemon_http_info') {
      if (h.infoMode === 'throw') throw new Error('ipc down')
      if (h.infoMode === 'null') return null
      return { base_url: 'http://127.0.0.1:9999', root_token: 'root-xyz' }
    }
    return null
  }),
}))

import { probeDaemonHttp, invalidateDaemonConnection } from '@/lib/daemon/daemon-local-client'

beforeEach(() => {
  h.isTauriVal = true
  h.infoMode = 'ok'
  h.healthzOk = true
  h.healthzThrows = false
  h.exchangeOk = true
  invalidateDaemonConnection()

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/healthz')) {
        if (h.healthzThrows) throw new Error('ECONNREFUSED')
        return { ok: h.healthzOk, status: h.healthzOk ? 200 : 503 } as Response
      }
      if (String(url).endsWith('/v1/auth/exchange')) {
        if (!h.exchangeOk) return { ok: false, status: 401 } as Response
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'sess-123', expires_in: 3600 }),
        } as unknown as Response
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('probeDaemonHttp reason classification', () => {
  it('not_tauri outside the desktop shell', async () => {
    h.isTauriVal = false
    expect(await probeDaemonHttp()).toEqual({ ok: false, reason: 'not_tauri' })
  })

  it('ipc_error when get_daemon_http_info throws', async () => {
    h.infoMode = 'throw'
    expect(await probeDaemonHttp()).toEqual({ ok: false, reason: 'ipc_error' })
  })

  it('port_file_missing when no http info (never started / cleaned)', async () => {
    h.infoMode = 'null'
    expect(await probeDaemonHttp()).toEqual({ ok: false, reason: 'port_file_missing' })
  })

  it('not_running when healthz connection is refused', async () => {
    h.healthzThrows = true
    expect(await probeDaemonHttp()).toEqual({ ok: false, reason: 'not_running' })
  })

  it('not_running when healthz returns non-2xx (stale port file)', async () => {
    h.healthzOk = false
    expect(await probeDaemonHttp()).toEqual({ ok: false, reason: 'not_running' })
  })

  it('token_invalid when healthz OK but token exchange is rejected', async () => {
    h.healthzOk = true
    h.exchangeOk = false
    expect(await probeDaemonHttp()).toEqual({ ok: false, reason: 'token_invalid' })
  })

  it('ok when healthz passes and the root token exchanges successfully', async () => {
    const probe = await probeDaemonHttp()
    expect(probe.ok).toBe(true)
    if (probe.ok) expect(probe.baseUrl).toBe('http://127.0.0.1:9999')
  })

  it('checks reachability BEFORE auth (down daemon never hits exchange)', async () => {
    h.healthzThrows = true
    await probeDaemonHttp()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const calledExchange = fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/v1/auth/exchange'))
    expect(calledExchange).toBe(false)
  })
})
