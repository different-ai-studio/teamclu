/**
 * Session binding live tests — requires `pnpm tauri:dev:daemon`.
 * Run: pnpm --filter @teamclu/app exec vitest run src/lib/__tests__/session-binding-live.test.ts
 */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentType } from '@/lib/proto/amux_pb'
import {
  RpcRequestSchema,
  RpcResponseSchema,
  RuntimeStartRequestSchema,
  RuntimeStopRequestSchema,
} from '@/lib/proto/teamclu_pb'

const TEAM_ID = '9159f762-bd35-40fe-a348-0ed2637c4986'
const AGENT_ACTOR = 'e08fb571-4498-44db-a5cf-b20d0c10c6cb'
const WORKSPACE_ID = 'e2d66039-dc54-4ccf-b869-8a5406183faf'
const DEFAULT_SESSION = '58969a79-abca-4c75-bb8c-8eb341ddd86e'
/** Disposable sessions — safe to purge bindings in live tests */
const PURGE_ONE_SESSION = '41851d94-1deb-4955-bac8-0f6e3815dd19'
const PURGE_ALL_SESSION = '5f333f13-b2df-4363-8281-e2296510d5c1'
const NOT_RESUMABLE_SESSION = '00f4254a-5823-4824-831b-98024609c3f6'

const RUN_DIR = path.join(os.homedir(), '.amuxd', 'run')
const RUNTIMES_PATH = path.join(
  os.homedir(),
  '.amuxd',
  'teams',
  TEAM_ID,
  'state',
  'runtimes.toml',
)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')

function daemonBase(): string {
  const port = fs.readFileSync(path.join(RUN_DIR, 'amuxd.http.port'), 'utf8').trim()
  return `http://127.0.0.1:${port}`
}

async function sessionToken(): Promise<string> {
  const root = fs.readFileSync(path.join(RUN_DIR, 'amuxd.http.token'), 'utf8').trim()
  const res = await fetch(`${daemonBase()}/v1/auth/exchange`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${root}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ttl_seconds: 3600,
      scopes: ['sessions:read', 'sessions:write', 'events:read', 'workspace:read'],
    }),
  })
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { token: string }
  return body.token
}

async function rpc(token: string, build: (req: ReturnType<typeof create<typeof RpcRequestSchema>>) => void) {
  const req = create(RpcRequestSchema, {
    requestId: crypto.randomUUID().slice(0, 8),
    requesterClientId: 'session-binding-harness',
    requesterActorId: AGENT_ACTOR,
  })
  build(req)
  const res = await fetch(`${daemonBase()}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-protobuf' },
    body: toBinary(RpcRequestSchema, req),
  })
  expect(res.ok).toBe(true)
  return fromBinary(RpcResponseSchema, new Uint8Array(await res.arrayBuffer()))
}

type StartResult = NonNullable<
  Extract<
    ReturnType<typeof fromBinary<typeof RpcResponseSchema>>['result'],
    { case: 'runtimeStartResult' }
  >['value']
>

async function tryStartRuntime(
  token: string,
  sessionId: string,
  resetBackendBinding = false,
): Promise<{ resp: ReturnType<typeof fromBinary<typeof RpcResponseSchema>>; result: StartResult }> {
  const resp = await rpc(token, (req) => {
    req.method = {
      case: 'runtimeStart',
      value: create(RuntimeStartRequestSchema, {
        agentType: AgentType.OPENCODE,
        workspaceId: WORKSPACE_ID,
        worktree: '',
        sessionId,
        initialPrompt: '',
        resetBackendBinding,
      }),
    }
  })
  expect(resp.result.case).toBe('runtimeStartResult')
  return { resp, result: resp.result.value as StartResult }
}

async function startRuntime(token: string, sessionId: string, resetBackendBinding = false) {
  const { resp, result } = await tryStartRuntime(token, sessionId, resetBackendBinding)
  expect(resp.success).toBe(true)
  expect(result.accepted).toBe(true)
  return result
}

async function stopRuntime(
  token: string,
  sessionId: string,
  opts: { purgeBinding?: boolean; workspaceId?: string } = {},
) {
  const purgeBinding = opts.purgeBinding ?? false
  const workspaceId = opts.workspaceId ?? (purgeBinding ? WORKSPACE_ID : '')
  const resp = await rpc(token, (req) => {
    req.method = {
      case: 'runtimeStop',
      value: create(RuntimeStopRequestSchema, {
        runtimeId: sessionId,
        purgeBinding,
        workspaceId,
      }),
    }
  })
  if (!resp.success) return null
  if (resp.result.case !== 'runtimeStopResult') return null
  return resp.result.value
}

function bindingCount(sessionId: string): number {
  if (!fs.existsSync(RUNTIMES_PATH)) return 0
  return fs
    .readFileSync(RUNTIMES_PATH, 'utf8')
    .split('[[bindings]]')
    .slice(1)
    .filter((b) => b.includes(`cloud_session_id = "${sessionId}"`)).length
}

function bindingAgentType(sessionId: string, workspaceId = WORKSPACE_ID): number | null {
  if (!fs.existsSync(RUNTIMES_PATH)) return null
  const blocks = fs.readFileSync(RUNTIMES_PATH, 'utf8').split('[[bindings]]').slice(1)
  for (const block of blocks) {
    if (
      block.includes(`cloud_session_id = "${sessionId}"`) &&
      block.includes(`workspace_id = "${workspaceId}"`)
    ) {
      const m = block.match(/agent_type\s*=\s*(\d+)/)
      return m ? Number(m[1]) : null
    }
  }
  return null
}

function bindingAcp(sessionId: string, workspaceId = WORKSPACE_ID): string | null {
  if (!fs.existsSync(RUNTIMES_PATH)) return null
  const blocks = fs.readFileSync(RUNTIMES_PATH, 'utf8').split('[[bindings]]').slice(1)
  for (const block of blocks) {
    if (
      block.includes(`cloud_session_id = "${sessionId}"`) &&
      block.includes(`workspace_id = "${workspaceId}"`)
    ) {
      const m = block.match(/acp_session_id\s*=\s*"([^"]+)"/)
      return m?.[1] ?? null
    }
  }
  return null
}

function skipUnlessDaemonUp(): boolean {
  try {
    return !fs.existsSync(path.join(RUN_DIR, 'amuxd.http.port'))
  } catch {
    return true
  }
}

describe('session binding harness (live daemon)', () => {
  const skip = skipUnlessDaemonUp()

  it.skipIf(skip)('TC-00: health + mqtt ready', async () => {
    const h = await fetch(`${daemonBase()}/v1/healthz`)
    expect(h.status).toBe(200)
    const info = (await (await fetch(`${daemonBase()}/v1/info`)).json()) as {
      mqtt?: { phase?: string }
    }
    expect(info.mqtt?.phase).toBe('Ready')
  })

  it.skipIf(skip)('TC-04: purge_binding removes one workspace row', async () => {
    const token = await sessionToken()
    await startRuntime(token, PURGE_ONE_SESSION)
    const before = bindingCount(PURGE_ONE_SESSION)
    expect(before).toBeGreaterThan(0)
    await stopRuntime(token, PURGE_ONE_SESSION, { purgeBinding: true, workspaceId: WORKSPACE_ID })
    expect(bindingCount(PURGE_ONE_SESSION)).toBe(before - 1)
  }, 120_000)

  it.skipIf(skip)('TC-05: purge_binding without workspace removes all session rows', async () => {
    const token = await sessionToken()
    await startRuntime(token, PURGE_ALL_SESSION)
    expect(bindingCount(PURGE_ALL_SESSION)).toBeGreaterThan(0)
    await stopRuntime(token, PURGE_ALL_SESSION, { purgeBinding: true, workspaceId: '' })
    expect(bindingCount(PURGE_ALL_SESSION)).toBe(0)
  }, 120_000)

  it('TC-06b/TC-07: session_store + session_resume rust unit tests', () => {
    const out = execSync(
      'node scripts/daemon-cargo.js test -p amuxd --bin amuxd config::session_store:: -- --quiet',
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300_000 },
    )
    expect(out).toMatch(/test result: ok/)
    const resumeOut = execSync(
      'node scripts/daemon-cargo.js test -p amuxd --bin amuxd session_resume:: -- --quiet',
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
    )
    expect(resumeOut).toMatch(/test result: ok/)
  }, 420_000)

  it.skipIf(skip)('TC-01: runtimeStart accepts bound session', async () => {
    const token = await sessionToken()
    const r = await startRuntime(token, DEFAULT_SESSION)
    expect(r.accepted).toBe(true)
    expect(r.runtimeId).toBe(DEFAULT_SESSION)
  }, 120_000)

  it.skipIf(skip)('TC-02: detach keeps binding row', async () => {
    const token = await sessionToken()
    await startRuntime(token, DEFAULT_SESSION)
    const before = bindingCount(DEFAULT_SESSION)
    expect(before).toBeGreaterThan(0)
    await stopRuntime(token, DEFAULT_SESSION, { purgeBinding: false })
    expect(bindingCount(DEFAULT_SESSION)).toBeGreaterThanOrEqual(before)
  }, 120_000)

  it.skipIf(skip)('TC-03: cold resume after detach', async () => {
    const token = await sessionToken()
    await stopRuntime(token, DEFAULT_SESSION, { purgeBinding: false })
    const r = await startRuntime(token, DEFAULT_SESSION)
    expect(r.accepted).toBe(true)
  }, 120_000)

  it.skipIf(skip)('TC-08: opencode binding agent_type cold resume', async () => {
    const token = await sessionToken()
    expect(bindingAgentType(DEFAULT_SESSION)).toBe(AgentType.OPENCODE)
    await stopRuntime(token, DEFAULT_SESSION, { purgeBinding: false })
    const r = await startRuntime(token, DEFAULT_SESSION)
    expect(r.accepted).toBe(true)
    expect(bindingAgentType(DEFAULT_SESSION)).toBe(AgentType.OPENCODE)
  }, 120_000)

  it.skipIf(skip)('TC-09: idle-eviction equivalent (detach) keeps binding + resume', async () => {
    const token = await sessionToken()
    await startRuntime(token, DEFAULT_SESSION)
    const before = bindingCount(DEFAULT_SESSION)
    expect(before).toBeGreaterThan(0)
    // Idle sweeper calls the same detach path as runtimeStop without purge.
    await stopRuntime(token, DEFAULT_SESSION, { purgeBinding: false })
    expect(bindingCount(DEFAULT_SESSION)).toBe(before)
    const r = await startRuntime(token, DEFAULT_SESSION)
    expect(r.accepted).toBe(true)
  }, 120_000)

  // NOT_RESUMABLE requires SessionStore reload (amuxd restart) — covered by rust tests +
  // manual steps in docs/debug/session-binding-manual-test.md. Live reset path below.
  it.skipIf(skip)('TC-06: reset_backend_binding replaces stale binding', async () => {
    const token = await sessionToken()
    await startRuntime(token, NOT_RESUMABLE_SESSION)
    const acpBefore = bindingAcp(NOT_RESUMABLE_SESSION)
    expect(acpBefore).toBeTruthy()
    await stopRuntime(token, NOT_RESUMABLE_SESSION, { purgeBinding: false })
    const ok = await startRuntime(token, NOT_RESUMABLE_SESSION, true)
    expect(ok.accepted).toBe(true)
    const acpAfter = bindingAcp(NOT_RESUMABLE_SESSION)
    expect(acpAfter).toBeTruthy()
    expect(acpAfter).not.toBe(acpBefore)
  }, 120_000)
})
