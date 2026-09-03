import { ComposerStack, type ActiveStreamingAgent } from "./ComposerStack";

export type { ActiveStreamingAgent };

/** Agent + approval chrome only (no plan/input). Prefer `ComposerStack` in ChatInputArea. */
export function StreamingAgentsDock({
  agents,
  onInterrupt,
}: {
  agents: ReadonlyArray<ActiveStreamingAgent>;
  onInterrupt: (agentId: string) => void;
}) {
  return <ComposerStack agents={agents} onInterrupt={onInterrupt} />;
}

/** @deprecated Use ComposerStack / StreamingAgentsDock */
export const StreamingAgentsBar = StreamingAgentsDock;
