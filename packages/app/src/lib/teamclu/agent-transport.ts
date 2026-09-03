import { probeDaemonHttp } from '@/lib/daemon-local-client'
import { getKnownLocalDaemonActorId } from '@/lib/local-daemon-identity'

/**
 * How this client will actually reach an agent.
 *
 * # Why this is decided once, at the outermost layer
 *
 * `teamclu-rpc` already routes a command to **this machine's** daemon over
 * loopback HTTP, never touching the broker. But the callers above it each
 * asked "is MQTT connected?" on their own and refused to proceed when it was
 * not — so a desktop that could not reach the cloud broker could not drive the
 * daemon running on the same machine, even though nothing in that path needs
 * the broker at all.
 *
 * Re-deriving "is this local?" at every gate is what made that easy to get
 * wrong: each gate saw a different slice of the truth. Resolving it once here
 * and threading the answer down means a run cannot be half-local — either the
 * whole flow is allowed to bypass MQTT, or none of it is.
 *
 * `local` is claimed only when the agent IS this device's daemon **and** it
 * answers on loopback right now. Anything else is `mqtt`, including a local
 * daemon that is down: there is no fast path to a process that is not running.
 */
type AgentTransport = 'local' | 'mqtt'

type AgentTransportPlan = {
  byAgent: Map<string, AgentTransport>
  /** Agents reachable without the broker. */
  local: string[]
  /** Agents that need the broker (remote, or a local daemon that is down). */
  mqtt: string[]
}

/** True when every agent in the plan bypasses MQTT. */
export function isFullyLocal(plan: AgentTransportPlan): boolean {
  return plan.mqtt.length === 0 && plan.local.length > 0
}

/**
 * Resolve the transport for one agent.
 *
 * The loopback probe is an active HTTP call, so callers should resolve once
 * per operation rather than per gate.
 */
export async function resolveAgentTransport(agentActorId: string): Promise<AgentTransport> {
  const agentId = agentActorId.trim()
  if (!agentId) return 'mqtt'
  const localId = getKnownLocalDaemonActorId()
  if (!localId || localId !== agentId) return 'mqtt'
  try {
    const probe = await probeDaemonHttp()
    return probe.ok ? 'local' : 'mqtt'
  } catch {
    // A failed probe means "cannot confirm loopback", which must fall back to
    // the broker rather than claim a fast path that does not exist.
    return 'mqtt'
  }
}

/**
 * Resolve transports for a batch. The loopback probe result is shared across
 * agents — there is exactly one local daemon, so probing per agent would just
 * repeat the same request.
 */
export async function planAgentTransports(
  agentActorIds: readonly string[],
): Promise<AgentTransportPlan> {
  const ids = agentActorIds.map((id) => id.trim()).filter(Boolean)
  const byAgent = new Map<string, AgentTransport>()
  const local: string[] = []
  const mqtt: string[] = []

  const localId = getKnownLocalDaemonActorId()
  const mentionsLocal = !!localId && ids.includes(localId)
  // Only pay for the probe when it can change an answer.
  const localReachable = mentionsLocal ? (await resolveAgentTransport(localId!)) === 'local' : false

  for (const id of ids) {
    const transport: AgentTransport =
      localReachable && id === localId ? 'local' : 'mqtt'
    byAgent.set(id, transport)
    ;(transport === 'local' ? local : mqtt).push(id)
  }

  return { byAgent, local, mqtt }
}
