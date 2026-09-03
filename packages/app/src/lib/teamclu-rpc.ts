import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  FetchWorkspacesRequestSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RuntimeStartRequestSchema,
  RuntimeStopRequestSchema,
  RuntimeCommandRequestSchema,
  SetModelRequestSchema,
  AgentCapabilityManagementRequestSchema,
  AgentCapabilityAction,
  AgentCapabilityKind,
  type AgentCapabilityManagementResult,
  type FetchWorkspacesResult,
  type RpcRequest,
  type RpcResponse,
  type RuntimeStartResult,
  type RuntimeStopResult,
  type SetModelResult,
} from '@/lib/proto/teamclu_pb'
import type { RuntimeCommandEnvelope } from '@/lib/proto/amux_pb'
import { mqttPublish, mqttSubscribe, listenForEnvelopes, type IncomingEnvelope } from '@/lib/mqtt-bridge'
import { recordMqttDiag } from '@/lib/mqtt-diagnostics'
import { getKnownLocalDaemonActorId } from '@/lib/local-daemon-identity'
import { resolveAgentDevicePresenceSync } from '@/lib/agent-device-reachability'
import { isTauri } from '@/lib/utils'
import { base64ToBytes, bytesToBase64 } from '@/lib/base64'
import { createSharedModuleLeaseManager, type SharedModuleLease } from '@/lib/shared-module-lease'

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (res: RpcResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let teamId: string | null = null
let requesterActorId: string | null = null
let initialized = false
const DEFAULT_TIMEOUT_MS = 30_000

type TeamcluRpcTransportErrorKind =
  | 'transport-not-ready'
  | 'publish-failed'
  | 'target-timeout'
  | 'cancelled'

class TeamcluRpcTransportError extends Error {
  constructor(
    public readonly kind: TeamcluRpcTransportErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'TeamcluRpcTransportError'
  }
}

// ---------------------------------------------------------------------------
// Init / dispose
// ---------------------------------------------------------------------------

/**
 * Identity is set, so a request can be *built*.
 *
 * Deliberately separate from [`isTeamcluRpcReady`]: the loopback fast path
 * needs nothing but `teamId` / `requesterActorId`, while the broker path also
 * needs the response subscription. Conflating the two meant a client that
 * could not reach the broker could not talk to its **own** daemon either — the
 * subscribe lives behind `connectMqttWithFreshAuth`, so with no broker the
 * whole wiring block never ran and `initialized` stayed false forever.
 */
export function isTeamcluRpcIdentityReady(): boolean {
  return teamId !== null && requesterActorId !== null
}

/** Identity **and** the MQTT response listener — required to reach a remote agent. */
export function isTeamcluRpcReady(): boolean {
  return initialized && isTeamcluRpcIdentityReady()
}

/** Poll until MQTT RPC listener is wired (App.tsx init), or timeout. */
export async function waitForTeamcluRpcReady(timeoutMs = 15_000): Promise<boolean> {
  return waitForRpc(isTeamcluRpcReady, timeoutMs, 'wait-ready')
}

/**
 * Poll until a request can be built, without waiting on the broker.
 * Callers that have already established a loopback transport use this.
 */
export async function waitForTeamcluRpcIdentity(timeoutMs = 15_000): Promise<boolean> {
  return waitForRpc(isTeamcluRpcIdentityReady, timeoutMs, 'wait-identity')
}

async function waitForRpc(
  ready: () => boolean,
  timeoutMs: number,
  diagLabel: string,
): Promise<boolean> {
  if (ready()) {
    recordMqttDiag('teamclu-rpc', `${diagLabel}:already-ready`, { timeoutMs, teamId })
    return true
  }
  recordMqttDiag('teamclu-rpc', `${diagLabel}:begin`, { timeoutMs, teamId, initialized })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if (ready()) {
      recordMqttDiag('teamclu-rpc', `${diagLabel}:ok`, { timeoutMs, teamId })
      return true
    }
  }
  recordMqttDiag('teamclu-rpc', `${diagLabel}:timeout`, { timeoutMs, teamId, initialized })
  return ready()
}

type RpcContext = { teamId: string; requesterActorId: string }

const identityLeaseManager = createSharedModuleLeaseManager<RpcContext>({
  key: (context) => `${context.teamId}:${context.requesterActorId}`,
  setup: async (context) => {
    teamId = context.teamId
    requesterActorId = context.requesterActorId
    recordMqttDiag('teamclu-rpc', 'identity:set', { teamId, requesterActorId })
  },
  onDeactivate: () => {
    teamId = null
    requesterActorId = null
  },
})

const brokerLeaseManager = createSharedModuleLeaseManager<RpcContext>({
  key: (context) => `${context.teamId}:${context.requesterActorId}`,
  setup: async (context, controls) => {
    const topic = `amux/${context.teamId}/+/rpc/res`
    // Listen first: a fast retained/loopback response must not beat the handler.
    const unlisten = await listenForEnvelopes(handleEnvelope)
    controls.setCleanup(unlisten)
    if (!controls.isCurrent()) return
    recordMqttDiag('teamclu-rpc', 'init:subscribe-before', { topic })
    await mqttSubscribe(topic)
    if (!controls.isCurrent()) return
    initialized = true
    recordMqttDiag('teamclu-rpc', 'init:ready', {
      teamId: context.teamId,
      requesterActorId: context.requesterActorId,
    })
  },
  onDeactivate: () => {
    initialized = false
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new TeamcluRpcTransportError('cancelled', 'rpc disposed'))
    }
    pending.clear()
  },
})

export function acquireTeamcluRpcIdentity(
  teamIdArg: string,
  requesterActorIdArg: string,
  ownerId: string,
): SharedModuleLease {
  const context = {
    teamId: teamIdArg.trim(),
    requesterActorId: requesterActorIdArg.trim(),
  }
  if (!context.teamId || !context.requesterActorId) {
    throw new Error('teamclu-rpc: teamId and requesterActorId required')
  }
  return identityLeaseManager.acquire(context, ownerId)
}

export function acquireTeamcluRpcBroker(
  teamIdArg: string,
  requesterActorIdArg: string,
  ownerId: string,
): SharedModuleLease {
  const context = {
    teamId: teamIdArg.trim(),
    requesterActorId: requesterActorIdArg.trim(),
  }
  if (!context.teamId || !context.requesterActorId) {
    throw new Error('teamclu-rpc: teamId and requesterActorId required')
  }
  return brokerLeaseManager.acquire(context, ownerId)
}

// ---------------------------------------------------------------------------
// Envelope handler
// ---------------------------------------------------------------------------

function handleEnvelope(env: IncomingEnvelope): void {
  if (!teamId) return
  // Match `amux/{team}/{any}/rpc/res`.
  const expectedPrefix = `amux/${teamId}/`
  const expectedSuffix = `/rpc/res`
  if (!env.topic.startsWith(expectedPrefix) || !env.topic.endsWith(expectedSuffix)) return
  recordMqttDiag('teamclu-rpc', 'response:received', { topic: env.topic, bytes: env.bytes.byteLength })
  let response: RpcResponse
  try {
    response = fromBinary(RpcResponseSchema, new Uint8Array(env.bytes))
  } catch (e) {
    console.warn('[teamclu-rpc] failed to decode RpcResponse', e)
    return
  }
  const p = pending.get(response.requestId)
  if (!p) {
    // Response for a request we don't own (or already timed out). Ignore quietly.
    recordMqttDiag('teamclu-rpc', 'response:no-pending', {
      topic: env.topic,
      requestId: response.requestId,
      success: response.success,
      resultCase: response.result.case,
    })
    return
  }
  pending.delete(response.requestId)
  clearTimeout(p.timer)
  recordMqttDiag('teamclu-rpc', 'response:matched', {
    topic: env.topic,
    requestId: response.requestId,
    success: response.success,
    resultCase: response.result.case,
    pending: pending.size,
  })
  p.resolve(response)
}

// ---------------------------------------------------------------------------
// Local HTTP fast path (Tauri only)
// ---------------------------------------------------------------------------
//
// When the target actor is this machine's amuxd daemon, commands go over
// loopback HTTP (`POST /v1/rpc` via the `daemon_rpc` Tauri command) instead
// of round-tripping through the cloud EMQX broker. Any local failure falls
// back to the MQTT path transparently and pauses the fast path for a cooldown
// window so a down daemon doesn't add per-request latency (no flapping).
// Browser builds and remote agents always use MQTT — behavior unchanged.

const LOCAL_RPC_TIMEOUT_MS = 10_000
const LOCAL_RPC_FAILURE_COOLDOWN_MS = 30_000
let localRpcFailedUntil = 0

/** @internal test hook */
export function __resetLocalRpcFailureForTest(): void {
  localRpcFailedUntil = 0
}

function shouldTryLocalRpc(targetActorId: string): boolean {
  if (!isTauri()) return false
  if (Date.now() < localRpcFailedUntil) return false
  const localActorId = getKnownLocalDaemonActorId()
  if (!localActorId || localActorId !== targetActorId) return false
  // Cached device-presence signal (local HTTP probe + daemon MQTT link, 5s
  // TTL). "offline" means the local daemon is known-unreachable right now;
  // skip straight to MQTT without burning the HTTP timeout.
  return resolveAgentDevicePresenceSync(targetActorId) !== 'offline'
}

function noteLocalRpcFailure(): void {
  localRpcFailedUntil = Date.now() + LOCAL_RPC_FAILURE_COOLDOWN_MS
}

async function sendViaLocalHttp(req: RpcRequest): Promise<RpcResponse> {
  const { invoke } = await import('@tauri-apps/api/core')
  const payloadB64 = bytesToBase64(toBinary(RpcRequestSchema, req))
  const replyB64 = await Promise.race([
    invoke<string>('daemon_rpc', { payloadB64 }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`local rpc timeout after ${LOCAL_RPC_TIMEOUT_MS}ms`)), LOCAL_RPC_TIMEOUT_MS),
    ),
  ])
  const response = fromBinary(RpcResponseSchema, base64ToBytes(replyB64))
  if (response.requestId !== req.requestId) {
    throw new Error(`local rpc response id mismatch: ${response.requestId} !== ${req.requestId}`)
  }
  return response
}

// ---------------------------------------------------------------------------
// Core send helper
// ---------------------------------------------------------------------------

async function sendRequest(
  build: (req: RpcRequest) => void,
  targetActorId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  /**
   * Override the generated request id. Only agent management uses this: its
   * grant is minted for one specific request id, so the id has to come from
   * the grant rather than from here.
   */
  fixedRequestId?: string,
): Promise<RpcResponse> {
  if (!targetActorId) {
    throw new Error('teamclu-rpc: targetActorId required')
  }
  // Decided before the guards: whether this request needs the broker at all.
  // `initialized` means the MQTT *response* subscription is wired, which the
  // loopback path never uses — demanding it here is what kept a client from
  // driving its own daemon while the broker was unreachable.
  const localFastPath = shouldTryLocalRpc(targetActorId)
  if (!teamId) {
    recordMqttDiag('teamclu-rpc', 'request:no-identity', { targetActorId, initialized })
    throw new TeamcluRpcTransportError('transport-not-ready', 'teamclu-rpc not initialized')
  }
  if (!requesterActorId) {
    throw new TeamcluRpcTransportError('transport-not-ready', 'teamclu-rpc: requesterActorId required')
  }
  if (!initialized && !localFastPath) {
    recordMqttDiag('teamclu-rpc', 'request:not-initialized', { targetActorId, initialized, teamId })
    throw new TeamcluRpcTransportError('transport-not-ready', 'teamclu-rpc not initialized')
  }
  const requestId = fixedRequestId ?? crypto.randomUUID()
  const requesterClientId = `teamclu-${requesterActorId.slice(0, 8)}-${requestId.slice(0, 8)}`

  const req = create(RpcRequestSchema, {
    requestId,
    requesterClientId,
    requesterActorId,
  })
  build(req) // caller fills the method oneof
  recordMqttDiag('teamclu-rpc', 'request:built', {
    requestId,
    targetActorId,
    requesterActorId,
    requesterClientId,
    method: req.method.case,
    timeoutMs,
    teamId,
  })

  // Local daemon fast path: loopback HTTP first, MQTT on any failure.
  if (localFastPath) {
    try {
      const response = await sendViaLocalHttp(req)
      recordMqttDiag('teamclu-rpc', 'request:local-http-ok', {
        requestId,
        targetActorId,
        method: req.method.case,
        success: response.success,
      })
      return response
    } catch (err) {
      noteLocalRpcFailure()
      recordMqttDiag('teamclu-rpc', 'request:local-http-fallback', {
        requestId,
        targetActorId,
        method: req.method.case,
        cooldownMs: LOCAL_RPC_FAILURE_COOLDOWN_MS,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      })
      // Falling through is only meaningful when the MQTT path can actually
      // answer. Without the response subscription the publish below would sit
      // there until it times out and then report a broker timeout — hiding the
      // real loopback error, which is the one the user can act on.
      if (!initialized) throw err
      // Fall through to the MQTT path below.
    }
  }

  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      recordMqttDiag('teamclu-rpc', 'request:timeout', {
        requestId,
        targetActorId,
        method: req.method.case,
        timeoutMs,
        pending: pending.size,
      })
      reject(new TeamcluRpcTransportError('target-timeout', `rpc timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    pending.set(requestId, { resolve, reject, timer })

    const topic = `amux/${teamId!}/${targetActorId}/rpc/req`
    recordMqttDiag('teamclu-rpc', 'request:publish-before', {
      requestId,
      topic,
      method: req.method.case,
      bytes: toBinary(RpcRequestSchema, req).byteLength,
    })
    mqttPublish(topic, toBinary(RpcRequestSchema, req), false).catch((err) => {
      clearTimeout(timer)
      pending.delete(requestId)
      recordMqttDiag('teamclu-rpc', 'request:publish-error', {
        requestId,
        topic,
        method: req.method.case,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      })
      reject(new TeamcluRpcTransportError(
        'publish-failed',
        err instanceof Error ? err.message : String(err),
        { cause: err },
      ))
    })
  })
}

function fetchWorkspacesResponseError(response: RpcResponse): Error | null {
  if (!response.success) {
    return new Error(response.error || 'fetchWorkspaces rejected')
  }
  if (response.result.case !== 'fetchWorkspacesResult') {
    return new Error(`unexpected result variant: ${response.result.case}`)
  }
  return null
}

// ---------------------------------------------------------------------------
// Public helper: fetchWorkspaces
// ---------------------------------------------------------------------------

interface FetchWorkspacesArgs {
  targetActorId: string
  timeoutMs?: number
}

export async function fetchWorkspaces(args: FetchWorkspacesArgs): Promise<FetchWorkspacesResult> {
  const response = await sendRequest((req) => {
    req.method = {
      case: 'fetchWorkspaces',
      value: create(FetchWorkspacesRequestSchema, {}),
    }
  }, args.targetActorId, args.timeoutMs)

  const error = fetchWorkspacesResponseError(response)
  if (error) throw error
  return response.result.value as FetchWorkspacesResult
}

/** Raw liveness probe: any well-formed response proves the target answered. */
export async function probeAgentRpcReachability(args: {
  targetActorId: string
  timeoutMs?: number
}): Promise<'reachable' | 'unreachable' | 'indeterminate'> {
  try {
    await sendRequest((req) => {
      req.method = {
        case: 'fetchWorkspaces',
        value: create(FetchWorkspacesRequestSchema, {}),
      }
    }, args.targetActorId, args.timeoutMs)
    return 'reachable'
  } catch (error) {
    if (error instanceof TeamcluRpcTransportError && error.kind === 'target-timeout') {
      return 'unreachable'
    }
    return 'indeterminate'
  }
}

export async function manageAgentCapability(args: {
  targetActorId: string
  managementGrant: string
  /**
   * The grant's `nonce`. Cloud API mints a grant for exactly one RPC request
   * id and the Agent rejects the grant on any other id, so a captured grant
   * can only ever be replayed onto the call the Agent already answered and
   * cached — that is what makes a grant single-use.
   */
  requestId: string
  kind: AgentCapabilityKind
  action: AgentCapabilityAction
  itemId?: string
  version?: number
  timeoutMs?: number
}): Promise<AgentCapabilityManagementResult> {
  const response = await sendRequest((req) => {
    req.method = {
      case: 'agentCapabilityManagement',
      value: create(AgentCapabilityManagementRequestSchema, {
        managementGrant: args.managementGrant,
        kind: args.kind,
        action: args.action,
        itemId: args.itemId ?? '',
        version: BigInt(args.version ?? 0),
      }),
    }
  }, args.targetActorId, args.timeoutMs, args.requestId)
  if (response.result.case !== 'agentCapabilityManagementResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  if (!response.success) {
    const code = response.result.value.errorCode
    throw new Error(code ? `${code}: ${response.error}` : response.error || 'agent management rejected')
  }
  return response.result.value
}

// ---------------------------------------------------------------------------
// Public helper: runtimeStart
// ---------------------------------------------------------------------------

export interface RuntimeStartArgs {
  targetActorId: string    // daemon actor_id to route the RPC to
  workspaceId: string       // supabase workspace id (or empty for bare spawn)
  worktree: string          // leave empty — target daemon resolves local path from workspaceId
  sessionId: string         // supabase session id
  agentType: number         // amux.AgentType enum (e.g., AgentType.CLAUDE_CODE)
  initialPrompt?: string
  modelId?: string
  /** Discard stored backend binding and spawn a fresh backend session. */
  resetBackendBinding?: boolean
  /** Lazy thread fork from parent session at anchor agent_reply. */
  forkFrom?: { parentSessionId: string; rootMessageId: string }
  timeoutMs?: number
}

export async function runtimeStart(args: RuntimeStartArgs): Promise<RuntimeStartResult> {

  const response = await sendRequest((req) => {
    const start = create(RuntimeStartRequestSchema, {
      workspaceId: args.workspaceId,
      worktree: args.worktree,
      sessionId: args.sessionId,
      agentType: args.agentType,
      initialPrompt: args.initialPrompt ?? '',
      modelId: args.modelId ?? '',
      resetBackendBinding: args.resetBackendBinding ?? false,
      forkFrom: args.forkFrom
        ? {
            parentSessionId: args.forkFrom.parentSessionId,
            rootMessageId: args.forkFrom.rootMessageId,
          }
        : undefined,
    })
    req.method = { case: 'runtimeStart', value: start }
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'runtimeStart rejected')
  }
  if (response.result.case !== 'runtimeStartResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value
}

// ---------------------------------------------------------------------------
// Public helper: runtimeStop (skeleton for M8)
// ---------------------------------------------------------------------------

export interface RuntimeStopArgs {
  targetActorId: string
  runtimeId: string
  /** removeAgent: delete runtimes.toml binding rows for this session */
  purgeBinding?: boolean
  /** optional precise delete when purgeBinding (empty = all workspaces) */
  workspaceId?: string
  timeoutMs?: number
}

export async function runtimeStop(args: RuntimeStopArgs): Promise<RuntimeStopResult> {
  const response = await sendRequest((req) => {
    const stop = create(RuntimeStopRequestSchema, {
      runtimeId: args.runtimeId,
      purgeBinding: args.purgeBinding ?? false,
      workspaceId: args.workspaceId ?? '',
    })
    req.method = { case: 'runtimeStop', value: stop }
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'runtimeStop rejected')
  }
  if (response.result.case !== 'runtimeStopResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value
}

// ---------------------------------------------------------------------------
// Public helper: runtimeCommand
// ---------------------------------------------------------------------------

interface RuntimeCommandArgs {
  targetActorId: string
  sessionId: string
  /** Serialised `amux.RuntimeCommandEnvelope`. */
  envelope: RuntimeCommandEnvelope
  timeoutMs?: number
}

/**
 * Send an AcpCommand addressed by (actor, session) rather than by a spawn id.
 *
 * Replaces publishing on `{actor}/runtime/{runtimeId}/commands`, which had no
 * reply path: a command aimed at a spawn the daemon no longer knew was dropped
 * with only a log line, and the UI sat waiting for a state change that never
 * came (docs/debug/interrupt-agent-stale-runtime.md).
 *
 * Returns false when the daemon holds no attachment for the session — the
 * session is cold. That is a real answer, not an error, and callers must not
 * report the command as delivered.
 */
export async function runtimeCommand(args: RuntimeCommandArgs): Promise<boolean> {
  const response = await sendRequest((req) => {
    const command = create(RuntimeCommandRequestSchema, {
      sessionId: args.sessionId,
      envelope: args.envelope,
    })
    req.method = { case: 'runtimeCommand', value: command }
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'runtimeCommand rejected')
  }
  if (response.result.case !== 'runtimeCommandResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  return response.result.value.dispatched
}

// ---------------------------------------------------------------------------
// Public helper: setModel
// ---------------------------------------------------------------------------

export interface SetModelArgs {
  targetActorId: string
  runtimeId: string
  modelId: string
  timeoutMs?: number
}

export async function setModel(args: SetModelArgs): Promise<SetModelResult> {
  const response = await sendRequest((req) => {
    const sm = create(SetModelRequestSchema, {
      runtimeId: args.runtimeId,
      modelId: args.modelId,
    })
    req.method = { case: 'setModel', value: sm }
  }, args.targetActorId, args.timeoutMs)

  if (!response.success) {
    throw new Error(response.error || 'setModel rejected')
  }
  if (response.result.case !== 'setModelResult') {
    throw new Error(`unexpected result variant: ${response.result.case}`)
  }
  const result = response.result.value
  if (!result.success) {
    throw new Error(result.error || 'setModel failed')
  }
  return result
}
