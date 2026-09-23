import { AgentType } from "@teamclu/app/proto/amux_pb";

export type ExpoAgentType = "pi" | "claude" | "opencode" | "codex";

export type RuntimeStartAgent = {
  actorId: string;
  displayName: string;
  agentTypes: string[];
  defaultAgentType: string | null;
  defaultWorkspaceId?: string | null;
};

export type RuntimeStartConnectedAgent = {
  agentId: string;
};

export type RuntimeStartWorkspace = {
  id: string;
  path: string | null;
  agentId: string | null;
};

export type RuntimeStartSelection = {
  workspaceId: string;
  agentType: ExpoAgentType;
};

export type RuntimeStartPlan = {
  agentActorId: string;
  targetActorId: string;
  workspaceId: string;
  worktree: string;
  agentType: AgentType;
};

export type RuntimeRestartRuntime = {
  agentId: string;
  runtimeId: string | null;
  workspaceId: string | null;
  backendType: string | null;
};

export type RuntimeRestartPlan = RuntimeStartPlan & {
  runtimeIdToStop: string;
};

type ResolveRuntimeStartPlansInput = {
  agents: RuntimeStartAgent[];
  connectedAgents: RuntimeStartConnectedAgent[];
  workspaces: RuntimeStartWorkspace[];
  /**
   * Per-agent workspace/type overrides, keyed by agent actor id.
   *
   * Keyed, not shared. A single selection applied to every agent started the
   * second agent in the first one's worktree — the exact thing `pickWorkspace`
   * refuses to do on the fallback path ("never borrow another agent's
   * team-visible row"). iOS keeps `agentConfigs[actorId]` for the same reason.
   */
  selectionByAgentId?: Readonly<Record<string, RuntimeStartSelection>> | null;
};

type ResolveRuntimeRestartPlanInput = {
  agent: RuntimeStartAgent;
  runtime: RuntimeRestartRuntime;
  connectedAgents: RuntimeStartConnectedAgent[];
  workspaces: RuntimeStartWorkspace[];
};

export function resolveExpoAgentType(
  value: string | null | undefined,
): AgentType {
  switch (value) {
    case "opencode":
      return AgentType.OPENCODE;
    case "codex":
      return AgentType.CODEX;
    case "cursor":
      return AgentType.CURSOR;
    case "claude-code":
    case "claude_code":
    case "claude":
      return AgentType.CLAUDE_CODE;
    case "pi":
    default:
      // The daemon runs pi only (ADR-0014). Defaulting to Claude Code sent a
      // `runtime_start` every current daemon refuses.
      return AgentType.PI;
  }
}

function pickAgentType(
  agent: RuntimeStartAgent,
  explicitSelection?: RuntimeStartSelection | null,
): AgentType {
  if (explicitSelection) return resolveExpoAgentType(explicitSelection.agentType);

  const known = new Set(["pi", "claude", "claude-code", "claude_code", "opencode", "codex", "cursor"]);
  const supported = agent.agentTypes.filter((type) => known.has(type));
  // The default only counts if the agent still lists it — a stale default is
  // exactly the `agent_type must be in agent_types` rejection.
  const preferred =
    agent.defaultAgentType &&
    (supported.length === 0 || supported.includes(agent.defaultAgentType))
      ? agent.defaultAgentType
      : supported[0] ?? "pi";
  return resolveExpoAgentType(preferred);
}

function pickWorkspace(
  agent: RuntimeStartAgent,
  workspaces: RuntimeStartWorkspace[],
  explicitSelection?: RuntimeStartSelection | null,
): RuntimeStartWorkspace {
  if (explicitSelection) {
    const selected = workspaces.find((workspace) => workspace.id === explicitSelection.workspaceId);
    if (!selected) {
      throw new Error("Selected workspace is no longer available.");
    }
    return selected;
  }

  if (agent.defaultWorkspaceId) {
    const defaultWorkspace = workspaces.find((workspace) => workspace.id === agent.defaultWorkspaceId);
    if (defaultWorkspace) return defaultWorkspace;
  }

  const ownedWorkspace = workspaces.find((workspace) => workspace.agentId === agent.actorId);
  if (ownedWorkspace) return ownedWorkspace;

  throw new Error(
    `No workspace bound to ${agent.displayName || "agent"} — register one on the daemon first.`,
  );
}

export function resolveAgentRuntimeStartPlans({
  agents,
  connectedAgents,
  workspaces,
  selectionByAgentId = null,
}: ResolveRuntimeStartPlansInput): RuntimeStartPlan[] {
  const connectedByAgentId = new Map(
    connectedAgents.map((agent) => [agent.agentId, agent]),
  );

  return agents.map((agent) => {
    // An agent's routing actor id IS its actorId; it must be connected (the
    // daemon publishes presence) before we can route a runtime_start to it.
    const connected = connectedByAgentId.get(agent.actorId);
    if (!connected) {
      throw new Error(`${agent.displayName || "Agent"} daemon is offline — wait for it to reconnect.`);
    }

    const selection = selectionByAgentId?.[agent.actorId] ?? null;
    const workspace = pickWorkspace(agent, workspaces, selection);
    return {
      agentActorId: agent.actorId,
      targetActorId: agent.actorId,
      workspaceId: workspace.id,
      worktree: workspace.path ?? "",
      agentType: pickAgentType(agent, selection),
    };
  });
}

export function resolveAgentRuntimeRestartPlan({
  agent,
  runtime,
  connectedAgents,
  workspaces,
}: ResolveRuntimeRestartPlanInput): RuntimeRestartPlan {
  const connected = connectedAgents.find((candidate) => candidate.agentId === agent.actorId);
  if (!connected) {
    throw new Error(`${agent.displayName || "Agent"} daemon is offline — wait for it to reconnect.`);
  }

  const runtimeWorkspaceId = runtime.workspaceId?.trim() ?? "";
  const workspace = runtimeWorkspaceId
    ? workspaces.find((candidate) => candidate.id === runtimeWorkspaceId) ??
      pickWorkspace(agent, workspaces)
    : pickWorkspace(agent, workspaces);

  return {
    agentActorId: agent.actorId,
    targetActorId: agent.actorId,
    runtimeIdToStop: runtime.runtimeId?.trim() ?? "",
    workspaceId: workspace.id,
    worktree: workspace.path ?? "",
    agentType: runtime.backendType
      ? resolveExpoAgentType(runtime.backendType)
      : pickAgentType(agent),
  };
}
