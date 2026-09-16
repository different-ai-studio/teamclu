/**
 * The app routes answer failures as RFC 7807 JSON, and the result's `error` goes
 * straight into a toast. Passing the body through is how a Windows user saw
 * 仓库克隆失败 over `{"type":"https://teamclu/errors/validation_failed",…}`
 * instead of git's reason. The error is the `detail`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ body: '', status: 422 }))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === 'get_daemon_http_info' ? { base_url: 'http://127.0.0.1:1111', root_token: 'root' } : null,
  ),
}))

import {
  buildDaemonApp,
  cloneDaemonApp,
  invalidateDaemonConnection,
  moveDaemonAppWorkdir,
  seedDaemonApp,
} from '@/lib/daemon/daemon-local-client'

const DETAIL = 'git clone failed: git@git.example.com: Permission denied (publickey).'

const failures: [string, () => Promise<{ outcome: string; error: string | null }>][] = [
  ['cloneDaemonApp', () => cloneDaemonApp('app-1', 'team-1', 'ssh://git@git.example.com:2222/o/r.git', 'pem')],
  ['seedDaemonApp', () => seedDaemonApp('app-1', 'team-1', 'App', 'web')],
  ['buildDaemonApp', () => buildDaemonApp('app-1', 'team-1', { presignedPut: 'https://oss.example.com/put' })],
  ['moveDaemonAppWorkdir', () => moveDaemonAppWorkdir('app-1', 'team-1', '/elsewhere')],
]

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

describe.each(failures)('%s', (_name, call) => {
  it('reports the problem detail, not the JSON body it arrived in', async () => {
    h.status = 422
    h.body = JSON.stringify({
      type: 'https://teamclu/errors/validation_failed',
      title: 'Validation failed',
      status: 422,
      detail: DETAIL,
      code: 'validation_failed',
    })
    const result = await call()
    expect(result.outcome).toBe('failed')
    expect(result.error).toBe(DETAIL)
  })

  it('still reports a body that is not JSON at all', async () => {
    h.status = 500
    h.body = 'upstream exploded'
    const result = await call()
    expect(result.outcome).toBe('failed')
    expect(result.error).toBe('upstream exploded')
  })
})
