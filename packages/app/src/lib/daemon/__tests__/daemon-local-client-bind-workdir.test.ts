/**
 * The daemon answers failures as RFC 7807 JSON. Passing that body through as
 * the error message is how a user was shown
 * `{"type":"https://teamclu/errors/validation_failed","title":…}` in a toast
 * titled 无法使用这个目录. The message is the `detail`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ body: '', status: 422 }))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === 'get_daemon_http_info' ? { base_url: 'http://127.0.0.1:1111', root_token: 'root' } : null,
  ),
}))

import { bindDaemonAppWorkdir, invalidateDaemonConnection } from '@/lib/daemon/daemon-local-client'

beforeEach(() => {
  invalidateDaemonConnection()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/exchange')) {
        return { ok: true, status: 200, json: async () => ({ token: 't', expires_in: 3600 }) } as unknown as Response
      }
      return { ok: false, status: h.status, text: async () => h.body } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bindDaemonAppWorkdir', () => {
  it('throws the problem detail, not the JSON body it arrived in', async () => {
    h.status = 422
    h.body = JSON.stringify({
      type: 'https://teamclu/errors/validation_failed',
      title: 'Validation failed',
      status: 422,
      detail: 'not a directory: /nowhere',
      code: 'validation_failed',
    })
    await expect(bindDaemonAppWorkdir('app-1', 'team-1', '/nowhere')).rejects.toThrow(
      /^not a directory: \/nowhere$/,
    )
  })

  it('still says something when the body is not JSON at all', async () => {
    h.status = 500
    h.body = 'upstream exploded'
    await expect(bindDaemonAppWorkdir('app-1', 'team-1', '/x')).rejects.toThrow('upstream exploded')
  })

  it('falls back to its own sentence on an empty body', async () => {
    h.status = 500
    h.body = ''
    await expect(bindDaemonAppWorkdir('app-1', 'team-1', '/x')).rejects.toThrow(
      'could not bind the app to that directory',
    )
  })
})
