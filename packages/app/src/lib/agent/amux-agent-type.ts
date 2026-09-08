import { AgentType } from "@/lib/proto/amux_pb"

/** Pi is the only local agent runtime (ADR-0014). */
export type AmuxAgentType = "pi"

/** Map any legacy cloud/backend label to the sole runtime the daemon runs. */
export function amuxAgentTypeFromBackend(
  backendType: string | null | undefined,
): AmuxAgentType | null {
  if (!backendType?.trim()) return null
  return "pi"
}

/** Resolve the AgentType wire value for runtime start. Always pi locally. */
export function resolveAmuxAgentType(
  _backendType?: string | null,
  _agentKind?: string | null,
): AgentType {
  return AgentType.PI
}
