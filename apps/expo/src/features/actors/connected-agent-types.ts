export type ConnectedAgent = {
  agentId: string;
  displayName: string;
  agentTypes: string[];
  defaultAgentType: string | null;
  permissionLevel: string;
  visibility: "team" | "personal";
  isOwner: boolean;
  lastActiveAt: string | null;
  /**
   * From the agent's retained `ActorPresence` — the daemon's Last Will flips
   * it to false the moment its connection drops. Undefined until the broker
   * has said anything, when `lastActiveAt` is all there is to go on.
   */
  presenceOnline?: boolean;
};

export type RuntimeAvailableCommand = {
  name: string;
  description: string;
  inputHint: string;
};

export type RuntimeInfo = {
  runtimeId: string;
  agentType: number;
  worktree: string;
  branch: string;
  status: number;
  startedAt: number;
  currentPrompt: string;
  workspaceId: string;
  sessionTitle: string;
  toolUseCount: number;
  availableModels: { id: string; displayName: string }[];
  currentModel: string;
  state: number;
  stage: string;
  errorCode: string;
  errorMessage: string;
  failedStage: string;
  availableCommands: RuntimeAvailableCommand[];
};

export type AgentAuthorizedHuman = {
  id: string;
  displayName: string;
  permissionLevel: string;
  grantedByActorId: string | null;
  lastActiveAt: string | null;
};

export function isAgentOnline(
  agent: Pick<ConnectedAgent, "lastActiveAt" | "presenceOnline">,
  now = Date.now(),
): boolean {
  if (agent.presenceOnline !== undefined) return agent.presenceOnline;
  if (!agent.lastActiveAt) return false;
  const t = Date.parse(agent.lastActiveAt);
  if (!Number.isFinite(t)) return false;
  return now - t < 120_000;
}
