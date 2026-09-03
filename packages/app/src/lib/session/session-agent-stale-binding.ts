import type { RuntimeInfo } from '@/lib/proto/amux_pb'
import {
  isSupersededLocalAgent,
  wasEverLocalDaemonIdentity,
} from '@/lib/daemon/local-daemon-identity'
import { isDriftedLocalGhostBinding } from '@/lib/session/session-agent-ui-state'

type EngagedAgentStaleBindingInput = {
  agentId: string
  localDaemonActorId: string | null
  presenceOnline: boolean | undefined
  agentRuntimeInfo: RuntimeInfo | undefined
  agentAvailableModelCount: number
  localRuntimeInfo: RuntimeInfo | undefined
  localAvailableModelCount: number
}

/** Whether an engaged agent pill should show stale / rebind-required UX. */
export function resolveEngagedAgentStaleBinding(
  input: EngagedAgentStaleBindingInput,
): boolean {
  const agentId = input.agentId.trim()
  if (!agentId) return false

  if (isSupersededLocalAgent(agentId)) return true
  if (!wasEverLocalDaemonIdentity(agentId)) return false

  return isDriftedLocalGhostBinding({
    agentId,
    localDaemonActorId: input.localDaemonActorId,
    presenceOnline: input.presenceOnline,
    agentRuntimeInfo: input.agentRuntimeInfo,
    agentAvailableModelCount: input.agentAvailableModelCount,
    localRuntimeInfo: input.localRuntimeInfo,
    localAvailableModelCount: input.localAvailableModelCount,
  })
}
