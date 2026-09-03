import { MessageKind } from "@/lib/proto/teamclu_pb";

/**
 * "Which model has this session already run with, for THIS agent?"
 *
 * Feeds `selectAgentModel({ sessionEstablishedModel })` from both the pill
 * (AgentSelectorDock) and the send path (ChatPanel). Both used to inline their
 * own copy of this scan; they must stay identical or the pill shows A while the
 * prompt runs on B.
 *
 * Resolution order, scanning the transcript newest-first:
 *
 *  1. The latest message authored by this agent — the strongest evidence.
 *  2. The latest message that is NOT another agent's output. In practice that
 *     is the user's own message, which carries the model the user had picked
 *     when sending, so a session that has never had a reply still resolves.
 *
 * Step 2 deliberately skips agent-authored messages from OTHER actors. Without
 * that guard, swapping agents mid-session (e.g. "switch to local agent" after
 * the remote one dies) made the new agent inherit the dead agent's model —
 * it was simply the latest modeled message in the transcript.
 */

type EstablishedModelMessage = {
  model?: string;
  senderActorId?: string;
  kind?: MessageKind;
};

function isAgentAuthoredKind(kind: MessageKind | undefined): boolean {
  switch (kind) {
    case MessageKind.AGENT_THINKING:
    case MessageKind.AGENT_TOOL_CALL:
    case MessageKind.AGENT_TOOL_RESULT:
    case MessageKind.AGENT_REPLY:
      return true;
    default:
      return false;
  }
}

export function resolveSessionEstablishedModel(
  messages: ReadonlyArray<EstablishedModelMessage> | undefined | null,
  agentId: string,
): string | null {
  const target = agentId.trim();
  if (!messages?.length || !target) return null;

  let fallback: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const model = message.model?.trim();
    if (!model) continue;
    if (message.senderActorId?.trim() === target) return model;
    // Another agent's model is not this agent's model.
    if (isAgentAuthoredKind(message.kind)) continue;
    if (!fallback) fallback = model;
  }
  return fallback;
}
