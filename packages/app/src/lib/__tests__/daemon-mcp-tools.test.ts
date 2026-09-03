import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'get_daemon_http_info') {
      return { base_url: 'http://127.0.0.1:9999', root_token: 'root' }
    }
    return null
  }),
}))

import {
  getDaemonMcpTools,
  installDaemonTeamMcp,
  reconcileDaemonTeamCloudConfig,
  uninstallDaemonTeamMcp,
  invalidateDaemonConnection,
} from '@/lib/daemon/daemon-local-client'

beforeEach(() => {
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
      if (u.includes('/mcp/tools')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            servers: {
              playwright: {
                probe_status: 'ready',
                tools: ['browser_click'],
                error: null,
                probed_at: '2026-06-05T00:00:00Z',
              },
            },
          }),
        } as unknown as Response
      }
      if (u.includes('/v1/team/mcp-servers/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ teamId: 'team-x', mcpChanged: true }),
        } as unknown as Response
      }
      if (u.endsWith('/v1/team/cloud-config/reconcile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ teamId: 'team-x', mcpChanged: true, envChanged: false }),
        } as unknown as Response
      }
      throw new Error(`unexpected fetch ${u} ${init?.method ?? ''}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getDaemonMcpTools', () => {
  it('returns per-server probe payload', async () => {
    const result = await getDaemonMcpTools('ws-id')
    expect(result.playwright.probe_status).toBe('ready')
    expect(result.playwright.tools).toEqual(['browser_click'])
  })

  it('appends refresh query when requested', async () => {
    await getDaemonMcpTools('ws-id', { refresh: true })
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((c) => String(c[0]).includes('/mcp/tools?refresh=true'))).toBe(true)
  })
})

describe('team MCP install/uninstall', () => {
  it('installs for the daemon actor via PUT', async () => {
    const result = await installDaemonTeamMcp('weather')
    expect(result).toEqual({ teamId: 'team-x', mcpChanged: true })
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const call = calls.find((c) => String(c[0]).includes('/v1/team/mcp-servers/weather/install'))
    expect(call).toBeTruthy()
    expect((call?.[1] as RequestInit)?.method).toBe('PUT')
  })

  it('uninstalls for the daemon actor via DELETE', async () => {
    const result = await uninstallDaemonTeamMcp('weather')
    expect(result).toEqual({ teamId: 'team-x', mcpChanged: true })
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const call = calls.find((c) => String(c[0]).includes('/v1/team/mcp-servers/weather/install'))
    expect(call).toBeTruthy()
    expect((call?.[1] as RequestInit)?.method).toBe('DELETE')
  })

  it('reconciles the daemon team cloud cache after catalog writes', async () => {
    const result = await reconcileDaemonTeamCloudConfig()
    expect(result).toEqual({ teamId: 'team-x', mcpChanged: true, envChanged: false })
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const call = calls.find((c) => String(c[0]).endsWith('/v1/team/cloud-config/reconcile'))
    expect(call).toBeTruthy()
    expect((call?.[1] as RequestInit)?.method).toBe('POST')
  })
})
