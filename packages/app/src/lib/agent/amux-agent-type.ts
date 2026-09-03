import { AgentType } from "@/lib/proto/amux_pb"

/**
 * The agent runtimes this client understands.
 *
 * Mirrors the backends amuxd actually implements — `runtime/create_backend`
 * has an arm for each of these and a module to go with it (`opencode_http/`,
 * `pi_rpc/`, `cursor_sdk/`, `claude_agent/`).
 *
 * `codex` is deliberately absent. `AgentType.CODEX` still exists in the proto,
 * and daemon config still parses a legacy `[agents.codex]` section, but there
 * is no codex backend module and no `create_backend` arm: a daemon configured
 * with `local_agent = "codex"` falls through to opencode. Claiming to support
 * it here only produced labels and model groupings for a runtime that never
 * runs.
 */
type AmuxAgentType = "claude-code" | "opencode" | "pi" | "cursor"

export function amuxAgentTypeFromBackend(
  backendType: string | null | undefined,
): AmuxAgentType | null {
  switch (backendType) {
    case "opencode":
      return "opencode"
    case "pi":
      return "pi"
    case "cursor":
      return "cursor"
    case "claude-code":
    case "claude":
    case "claude_code":
      return "claude-code"
    default:
      return null
  }
}

export function resolveAmuxAgentType(
  backendType: string | null | undefined,
  agentKind?: string | null,
): AgentType {
  switch (backendType) {
    case "opencode":
      return AgentType.OPENCODE
    case "pi":
      return AgentType.PI
    case "cursor":
      return AgentType.CURSOR
    case "claude-code":
    case "claude":
    case "claude_code":
      return AgentType.CLAUDE_CODE
  }

  switch (agentKind) {
    case "daemon":
    case "amuxd":
    case "opencode":
      return AgentType.OPENCODE
    case "cursor":
      return AgentType.CURSOR
    case "pi":
      return AgentType.PI
  }

  // Single-agent mode: unknown agent-type strings default to opencode.
  return AgentType.OPENCODE
}
