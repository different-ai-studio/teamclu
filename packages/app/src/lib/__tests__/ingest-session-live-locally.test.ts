import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:3333',
  lastIngest: null as null | { url: string; headers: HeadersInit | undefined; body: BodyInit | null | undefined },
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

import { ingestSessionLiveLocally, invalidateDaemonConnection } from '@/lib/daemon/daemon-local-client'

beforeEach(() => {
  h.lastIngest = null
  invalidateDaemonConnection()

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)

      if (u.endsWith('/v1/auth/exchange')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'sess-123', expires_in: 3600 }),
        } as unknown as Response
      }

      if (u.includes('/v1/session-live/ingest')) {
        h.lastIngest = { url: u, headers: init?.headers, body: init?.body ?? null }
        return {
          ok: true,
          status: 202,
          text: async () => '',
          json: async () => {
            throw new Error('no json body')
          },
        } as unknown as Response
      }

      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ingestSessionLiveLocally', () => {
  it('POSTs protobuf LiveEventEnvelope bytes to the local ingest route', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    await ingestSessionLiveLocally('sess-abc', bytes)

    expect(h.lastIngest).not.toBeNull()
    expect(h.lastIngest!.url).toBe(
      'http://127.0.0.1:3333/v1/session-live/ingest?session_id=sess-abc',
    )
    const headers = new Headers(h.lastIngest!.headers)
    expect(headers.get('Content-Type')).toBe('application/x-protobuf')
    expect(headers.get('Authorization')).toBe('Bearer sess-123')
    expect(h.lastIngest!.body).toBe(bytes)
  })

  it('rejects empty session id and empty payload', async () => {
    await expect(ingestSessionLiveLocally('  ', new Uint8Array([1]))).rejects.toThrow(
      /session_id/,
    )
    await expect(ingestSessionLiveLocally('sess', new Uint8Array())).rejects.toThrow(
      /empty live envelope/,
    )
  })
})
