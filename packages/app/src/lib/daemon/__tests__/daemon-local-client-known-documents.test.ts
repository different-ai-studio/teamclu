/**
 * The daemon reads this query as `StatusQuery`, which is `rename_all = "camelCase"`.
 * Sending `team_id` got `400 missing field teamId`, the tree caught it as "no
 * listed documents", and every document not yet on this device vanished from
 * 资料库 — on every machine, with nothing in the UI to say why.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === 'get_daemon_http_info' ? { base_url: 'http://127.0.0.1:1111', root_token: 'root' } : null,
  ),
}))

import { invalidateDaemonConnection, listKnownDocuments } from '@/lib/daemon/daemon-local-client'

const LISTED = [{ path: 'documents/运营部/index.md', version: 1, size: 22 }]

beforeEach(() => {
  invalidateDaemonConnection()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/auth/exchange') {
        return { ok: true, status: 200, json: async () => ({ token: 't', expires_in: 3600 }) } as unknown as Response
      }
      // What axum's `Query<StatusQuery>` does with any other spelling.
      if (!url.searchParams.get('teamId')) {
        return {
          ok: false,
          status: 400,
          text: async () => 'Failed to deserialize query string: missing field `teamId`',
        } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => LISTED } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listKnownDocuments', () => {
  it('asks with the parameter name the daemon reads', async () => {
    await expect(listKnownDocuments('team-1')).resolves.toEqual(LISTED)
  })
})
