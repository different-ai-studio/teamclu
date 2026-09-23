import type { SessionMessage, StreamingBuffer } from "./session-types";

const RUNTIME_DETAIL_KINDS = new Set([
  "agent_thinking",
  "agent_tool_call",
  "agent_tool_result",
  "plan_update",
]);

const FINAL_AGENT_KINDS = new Set(["agent_reply"]);

export type AgentTurnFeedItem = {
  agentId: string;
  createdAt: string;
  /**
   * The daemon's own turn id, when any message in this turn carried one.
   * Distinct from `id`, which falls back to a synthetic `turn:`/`stream:` key
   * so every turn has a stable React key. Only this value is meaningful to
   * `AcpRequestTurnHistory` — a synthetic id would match nothing on the daemon.
   */
  daemonTurnId?: string;
  finalMessage?: SessionMessage;
  id: string;
  isActive: boolean;
  runtimeEvents: SessionMessage[];
  stream?: StreamingBuffer;
};

export type SessionFeedSource =
  | { kind: "message"; key: string; createdAt: string; message: SessionMessage }
  | { kind: "agentTurn"; key: string; createdAt: string; turn: AgentTurnFeedItem };

type BuildSessionFeedOptions = {
  ownActorId?: string | null;
};

function kindKey(message: SessionMessage): string {
  return message.kind.trim().toLowerCase();
}

function senderKey(message: SessionMessage): string {
  return message.senderActorId.trim() || "(unattributed)";
}

function isRuntimeDetail(message: SessionMessage): boolean {
  return RUNTIME_DETAIL_KINDS.has(kindKey(message));
}

function isFinalAgentMessage(
  message: SessionMessage,
  hasOpenRuntimeTurn: boolean,
  ownActorId?: string | null,
): boolean {
  const kind = kindKey(message);
  if (FINAL_AGENT_KINDS.has(kind)) return true;
  if (kind !== "text") return false;
  if (!hasOpenRuntimeTurn) return false;
  return !ownActorId || message.senderActorId !== ownActorId;
}

function turnIdForFinal(message: SessionMessage): string {
  const explicit = message.turnId.trim();
  if (explicit) return explicit;
  return `turn:${message.messageId}`;
}

function turnIdForOpen(
  agentId: string,
  runtimeEvents: readonly SessionMessage[],
  stream?: StreamingBuffer,
): string {
  const firstRuntime = runtimeEvents[0];
  if (firstRuntime) return `turn:${firstRuntime.messageId}`;
  if (stream) return `stream:${agentId}:${stream.messageId}`;
  return `stream:${agentId}`;
}

function feedKeyForTurn(agentId: string, turnId: string): string {
  return `agentTurn:${agentId}:${turnId}`;
}

/** First real `turnId` across a turn's messages, or undefined if none carried one. */
function daemonTurnId(
  messages: ReadonlyArray<SessionMessage | undefined>,
): string | undefined {
  for (const message of messages) {
    const turnId = message?.turnId.trim();
    if (turnId) return turnId;
  }
  return undefined;
}

function createdAtForOpen(
  runtimeEvents: readonly SessionMessage[],
  stream?: StreamingBuffer,
): string {
  return runtimeEvents[0]?.createdAt || stream?.startedAt || new Date(0).toISOString();
}

function byCreatedAtThenKey(left: SessionFeedSource, right: SessionFeedSource): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const delta =
    (Number.isFinite(leftTime) ? leftTime : 0) -
    (Number.isFinite(rightTime) ? rightTime : 0);
  if (delta !== 0) return delta;
  return left.key.localeCompare(right.key);
}

function timeValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeFinalMessage(
  existing: SessionMessage,
  incoming: SessionMessage,
): SessionMessage {
  const existingText = existing.content;
  const incomingText = incoming.content;
  const existingTime = timeValue(existing.createdAt);
  const incomingTime = timeValue(incoming.createdAt);
  const incomingIsLater = incomingTime >= existingTime;
  const base = incomingIsLater ? incoming : existing;
  const content =
    existingText === incomingText
      ? existingText
      : incomingTime < existingTime
        ? `${incomingText}${existingText}`
        : `${existingText}${incomingText}`;

  return {
    ...base,
    content,
    model: base.model || existing.model || incoming.model,
    turnId: base.turnId || existing.turnId || incoming.turnId,
  };
}

function mergeRuntimeEvents(
  existing: readonly SessionMessage[],
  incoming: readonly SessionMessage[],
): SessionMessage[] {
  if (incoming.length === 0) return [...existing];
  const seen = new Set(existing.map((event) => event.messageId));
  const merged = [...existing];
  for (const event of incoming) {
    if (seen.has(event.messageId)) continue;
    seen.add(event.messageId);
    merged.push(event);
  }
  merged.sort((left, right) => {
    const delta = timeValue(left.createdAt) - timeValue(right.createdAt);
    if (delta !== 0) return delta;
    return left.messageId.localeCompare(right.messageId);
  });
  return merged;
}

/**
 * Converts raw persisted/runtime message rows into the main chat feed shape.
 * Runtime detail stays available on the turn, but only permission/error/final
 * user-facing items occupy their own row in the primary conversation.
 */
export function buildSessionFeedSources(
  messages: readonly SessionMessage[],
  streamingByAgent: ReadonlyMap<string, StreamingBuffer> = new Map(),
  options: BuildSessionFeedOptions = {},
): SessionFeedSource[] {
  const openRuntimeByAgent = new Map<string, SessionMessage[]>();
  const completedTurnIndexByKey = new Map<string, number>();
  const sources: SessionFeedSource[] = [];

  for (const message of messages) {
    const agentId = senderKey(message);

    if (isRuntimeDetail(message)) {
      const runtime = openRuntimeByAgent.get(agentId) ?? [];
      runtime.push(message);
      openRuntimeByAgent.set(agentId, runtime);
      continue;
    }

    const runtimeEvents = openRuntimeByAgent.get(agentId) ?? [];
    if (isFinalAgentMessage(message, runtimeEvents.length > 0, options.ownActorId)) {
      openRuntimeByAgent.delete(agentId);
      const turnId = turnIdForFinal(message);
      const completedTurnKey = `${agentId}:${turnId}`;
      const existingIndex = completedTurnIndexByKey.get(completedTurnKey);
      if (existingIndex !== undefined) {
        const existingSource = sources[existingIndex];
        if (existingSource?.kind === "agentTurn") {
          const existingTurn = existingSource.turn;
          sources[existingIndex] = {
            ...existingSource,
            createdAt: message.createdAt || existingSource.createdAt,
            turn: {
              ...existingTurn,
              daemonTurnId:
                existingTurn.daemonTurnId ?? daemonTurnId([message, ...runtimeEvents]),
              finalMessage: existingTurn.finalMessage
                ? mergeFinalMessage(existingTurn.finalMessage, message)
                : message,
              runtimeEvents: mergeRuntimeEvents(
                existingTurn.runtimeEvents,
                runtimeEvents,
              ),
            },
          };
          continue;
        }
      }
      const turn: AgentTurnFeedItem = {
        agentId,
        createdAt: runtimeEvents[0]?.createdAt || message.createdAt,
        daemonTurnId: daemonTurnId([message, ...runtimeEvents]),
        finalMessage: message,
        id: turnId,
        isActive: false,
        runtimeEvents,
      };
      const nextSource: SessionFeedSource = {
        kind: "agentTurn",
        key: feedKeyForTurn(agentId, turn.id),
        createdAt: message.createdAt || turn.createdAt,
        turn,
      };
      completedTurnIndexByKey.set(completedTurnKey, sources.length);
      sources.push(nextSource);
      continue;
    }

    sources.push({
      kind: "message",
      key: message.messageId,
      createdAt: message.createdAt,
      message,
    });
  }

  const liveAgentIds = new Set<string>([
    ...Array.from(openRuntimeByAgent.keys()),
    ...Array.from(streamingByAgent.keys()),
  ]);

  const openTurns = Array.from(liveAgentIds).map<SessionFeedSource>((agentId) => {
    const runtimeEvents = openRuntimeByAgent.get(agentId) ?? [];
    const stream = streamingByAgent.get(agentId);
    const turn: AgentTurnFeedItem = {
      agentId,
      createdAt: createdAtForOpen(runtimeEvents, stream),
      daemonTurnId: daemonTurnId(runtimeEvents),
      id: turnIdForOpen(agentId, runtimeEvents, stream),
      // A stream the agent has closed (final delta, or its idle status) is
      // over even when no reply row was committed — the daemon's own follow-up
      // turns (retitling a session) end that way. Showing them as "replying"
      // left a card spinning next to an idle agent.
      isActive: !stream?.isComplete,
      runtimeEvents,
      stream,
    };
    return {
      kind: "agentTurn",
      key: feedKeyForTurn(agentId, turn.id),
      createdAt: turn.createdAt,
      turn,
    };
  });

  openTurns.sort(byCreatedAtThenKey);
  return [...sources, ...openTurns];
}
