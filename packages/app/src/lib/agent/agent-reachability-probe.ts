import { probeAgentRpcReachability } from '@/lib/daemon/teamclu-rpc'
import { probeDaemonHttp } from '@/lib/daemon/daemon-local-client'

type AgentReachability = 'pending' | 'reachable' | 'unreachable' | 'indeterminate'

const SESSION_AGENT_RPC_PROBE_TIMEOUT_MS = 3_000

/** Probe whether the engaged agent's daemon answers on this machine or over MQTT RPC. */
export async function probeAgentReachability(args: {
  agentActorId: string
  localDaemonActorId: string | null
  rpcTimeoutMs?: number
}): Promise<Exclude<AgentReachability, 'pending'>> {
  const agentId = args.agentActorId.trim()
  const localId = args.localDaemonActorId?.trim() || null
  const rpcTimeoutMs = args.rpcTimeoutMs ?? SESSION_AGENT_RPC_PROBE_TIMEOUT_MS

  if (localId && agentId === localId) {
    const probe = await probeDaemonHttp()
    return probe.ok ? 'reachable' : 'unreachable'
  }

  return probeAgentRpcReachability({ targetActorId: agentId, timeoutMs: rpcTimeoutMs })
}
