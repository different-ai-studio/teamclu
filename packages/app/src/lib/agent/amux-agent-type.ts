import { AgentType } from "@/lib/proto/amux_pb"

/** Pi is the only local agent runtime (ADR-0014). */
export type AmuxAgentType = "pi"

/** Resolve the AgentType wire value for runtime start. Always pi locally. */
export function resolveAmuxAgentType(
  _backendType?: string | null,
  _agentKind?: string | null,
): AgentType {
  return AgentType.PI
}
