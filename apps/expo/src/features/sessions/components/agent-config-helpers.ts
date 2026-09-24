export type AgentType = "pi" | "claude" | "opencode" | "codex";

/** The ordered list of agent types shown in the segmented control. */
export const AGENT_TYPE_ORDER: readonly AgentType[] = ["pi", "claude", "opencode", "codex"];

/**
 * What to offer when an agent lists no type we recognise. The daemon runs pi
 * and nothing else (ADR-0014); offering the legacy backends here would let
 * someone pick a `runtime_start` that is refused.
 */
export const FALLBACK_AGENT_TYPES: readonly AgentType[] = ["pi"];

/**
 * The types this agent can actually run, in display order — iOS
 * `AgentConfigSheet.AgentType.supported(from:)`.
 *
 * Offering every type regardless is not cosmetic: picking a backend the agent
 * does not support sends a `runtime_start` it cannot honour. An empty or
 * entirely unrecognised list falls back to pi, the one backend the daemon
 * still runs.
 */
export function supportedAgentTypes(
  storedValues: ReadonlyArray<string> | null | undefined,
): readonly AgentType[] {
  if (!storedValues || storedValues.length === 0) return FALLBACK_AGENT_TYPES;
  const supported = new Set<AgentType>();
  for (const value of storedValues) {
    const normalized = normalizeStoredAgentType(value);
    if (normalized) supported.add(normalized);
  }
  if (supported.size === 0) return FALLBACK_AGENT_TYPES;
  return AGENT_TYPE_ORDER.filter((type) => supported.has(type));
}

/**
 * The same agent is stored as `claude`, `claude_code` or `claude-code`
 * depending on the writer, so every reader has to fold them together.
 */
export function normalizeStoredAgentType(
  value: string | null | undefined,
): AgentType | null {
  switch (value) {
    case "claude":
    case "claude_code":
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "pi":
      return "pi";
    default:
      return null;
  }
}

/** Returns the id of the first workspace, or an empty string if the list is empty. */
export function initialWorkspaceId(workspaces: { id: string }[]): string {
  return workspaces[0]?.id ?? "";
}

/** The Add button is only enabled when a workspace has been selected. */
export function canConfirmSelection(workspaceId: string): boolean {
  return workspaceId.length > 0;
}

/**
 * Clamps a preferred type into the offered set — iOS
 * `AddAgentSheet.handleTap`. Without it a `defaultType` outside the set
 * leaves no segment looking selected and still confirms that type.
 */
export function resolveInitialAgentType(
  preferred: AgentType,
  offered: readonly AgentType[],
): AgentType {
  if (offered.length === 0) return preferred;
  return offered.includes(preferred) ? preferred : offered[0];
}
