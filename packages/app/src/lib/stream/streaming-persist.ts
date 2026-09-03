// Persist ordered runtime parts from the in-memory streaming entry onto the
// final AGENT_REPLY row. The daemon persists reply text to Supabase, while
// thinking/tool events are live-only; `parts_json` lets reload restore the
// same text/tool ordering without reconstructing it from synthetic rows.

import {
  deriveAgentReplyContent,
  joinTextPartsFromParts,
} from "@/lib/agent/agent-reply-transcript";
import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import type { MessagePart, ToolCall } from "@/stores/session-types";
import {
  finishUnresolvedTools,
  syncToolPartsForPersist,
  type AgentStreamEntry,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";
import { enrichMessageParts, setMessageParts } from "@/lib/cache/local-cache";
import { useWorkspaceStore } from "@/stores/workspace";
import { snapshotSubagentEntry } from "@/lib/agent/subagent-snapshot";
import { extractTaskChildBinding, isTaskToolCall } from "@/lib/teamclu/subagent-acp-binding";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { getFlushedTurn } from "@/lib/stream/flushed-turn-registry";
import { toolUseArguments } from "@/stores/v2-stream-parts";
import type { ToolCallContentBlock } from "@/components/chat/tool-calls/tool-call-content";

/** Snapshot live transcript parts — the only canonical source for parts_json. */
export function snapshotTranscriptParts(
  entry: AgentStreamEntry | undefined,
): MessagePart[] {
  if (!entry) return [];
  return entry.parts.filter(
    (part) =>
      (part.type === "reasoning" && Boolean(part.text || part.content)) ||
      (part.type === "text" && Boolean(part.text || part.content)) ||
      (part.type === "tool-call" && Boolean(part.toolCall)),
  );
}

/**
 * Finish in-flight tools on a stream snapshot before writing parts_json.
 * Prevents reload from restoring a permanent "running" spinner when idle
 * arrives before the late toolResult (opencode abort order).
 */
function finalizeStreamEntryForPersist(
  entry: AgentStreamEntry,
): AgentStreamEntry {
  const cloned = cloneStreamEntrySnapshot(entry);
  const toolCalls = finishUnresolvedTools(cloned.toolCalls);
  return {
    ...cloned,
    toolCalls,
    parts: syncToolPartsForPersist(cloned.parts, toolCalls),
    active: false,
  };
}

/** Attach nested subagent snapshots onto task tool-call parts before persist. */
export function mergeSubagentSnapshotsIntoParts(
  parts: MessagePart[],
  _sessionId: string,
  _actorId: string,
): MessagePart[] {
  const state = useV2StreamingStore.getState();
  return parts.map((part) => {
    if (part.type !== "tool-call" || !part.toolCall || !isTaskToolCall(part.toolCall)) {
      return part;
    }
    const toolId = part.toolCall.id;
    const subEntry =
      state.subagentByToolId[toolId] ?? state.archivedSubagentByToolId[toolId];
    const snapshot = snapshotSubagentEntry(subEntry);
    if (snapshot.length === 0) return part;
    const childAcpSessionId =
      Object.entries(state.childAcpSessionToToolId).find(
        ([, mappedToolId]) => mappedToolId === toolId,
      )?.[0] ??
      extractTaskChildBinding(part.toolCall.rawOutput)?.childAcpSessionId;
    return {
      ...part,
      toolCall: {
        ...part.toolCall,
        metadata: {
          ...part.toolCall.metadata,
          childAcpSessionId,
          subagentSnapshot: snapshot,
        },
      },
    };
  });
}

function parsePartsJson(partsJson: string): MessagePart[] {
  try {
    const parts = JSON.parse(partsJson) as MessagePart[];
    return Array.isArray(parts) ? parts : [];
  } catch {
    return [];
  }
}

async function enrichPartsJson(partsJson: string): Promise<string> {
  return enrichMessageParts(partsJson, useWorkspaceStore.getState().workspacePath);
}

function reviveStartTime(raw: unknown): Date {
  if (raw instanceof Date) return new Date(raw.getTime());
  if (typeof raw === "string" || typeof raw === "number") return new Date(raw);
  return new Date();
}

/** Deep-copy a stream entry so async flush survives beginPlanningPlaceholder. */
export function cloneStreamEntrySnapshot(entry: AgentStreamEntry): AgentStreamEntry {
  return {
    ...entry,
    parts: entry.parts.map((part) => ({
      ...part,
      toolCall: part.toolCall
        ? {
            ...part.toolCall,
            startTime: reviveStartTime(part.toolCall.startTime),
          }
        : undefined,
    })),
    toolCalls: entry.toolCalls.map((toolCall) => ({
      ...toolCall,
      startTime: reviveStartTime(toolCall.startTime),
    })),
    planEntries: [...entry.planEntries],
  };
}

/** Pick the best stream entry for parts_json before async work can clobber byKey. */
export function resolveStreamEntryForPersist(
  sessionId: string,
  actorId: string,
  hint?: AgentStreamEntry | null,
): AgentStreamEntry | undefined {
  if (hint && snapshotTranscriptParts(hint).length > 0) return hint;

  const key = `${sessionId}::${actorId}`;
  const live = useV2StreamingStore.getState().byKey[key];
  if (live && snapshotTranscriptParts(live).length > 0) return live;

  const archived = useV2StreamingStore
    .getState()
    .archived.filter((entry) => entry.sessionId === sessionId && entry.actorId === actorId)
    .reverse();
  return archived.find((entry) => snapshotTranscriptParts(entry).length > 0);
}

export async function syncStreamingToolOutputsFromLocalCache(
  sessionId: string,
  actorId: string,
): Promise<void> {
  const entry =
    useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
  const parts = snapshotTranscriptParts(entry);
  if (parts.length === 0) return;
  const partsJson = JSON.stringify(parts);
  const enrichedPartsJson = await enrichPartsJson(partsJson);
  if (enrichedPartsJson === partsJson) return;
  const enrichedParts = parsePartsJson(enrichedPartsJson);
  if (enrichedParts.length === 0) return;
  useV2StreamingStore.getState().replaceParts(sessionId, actorId, enrichedParts);
}

/** Called from the live MQTT handler when the turn ends. Snapshots live parts[]
 * onto the final reply as `parts_json` and persists that blob to libsql. */
export async function persistStreamingPartsForReply(
  sessionId: string,
  actorId: string,
  reply: TeamcluMessage,
  pendingReplies: TeamcluMessage[] = [],
  opts?: { streamEntrySnapshot?: AgentStreamEntry },
): Promise<TeamcluMessage> {
  const turnId = reply.turnId;
  if (!turnId) return reply;
  const rawSnapshot =
    opts?.streamEntrySnapshot ??
    resolveStreamEntryForPersist(sessionId, actorId);
  const snapshot = rawSnapshot
    ? finalizeStreamEntryForPersist(rawSnapshot)
    : undefined;
  const parts = mergeSubagentSnapshotsIntoParts(
    snapshotTranscriptParts(snapshot),
    sessionId,
    actorId,
  );
  if (parts.length === 0) return reply;

  const content = deriveAgentReplyContent(parts, pendingReplies.length > 0 ? pendingReplies : [reply]);
  Object.assign(reply, { content });

  const partsJson = JSON.stringify(parts);
  try {
    const enrichedPartsJson = await setMessageParts(
      reply.messageId,
      partsJson,
      useWorkspaceStore.getState().workspacePath,
    );
    Object.assign(reply, { partsJson: enrichedPartsJson });
    const enrichedParts = parsePartsJson(enrichedPartsJson);
    const live = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
    if (
      enrichedParts.length > 0 &&
      live &&
      snapshot &&
      live.streamId === snapshot.streamId
    ) {
      useV2StreamingStore.getState().replaceParts(sessionId, actorId, enrichedParts);
    }
  } catch (e) {
    Object.assign(reply, { partsJson });
    console.warn("[streaming-persist] parts_json write failed:", e);
  }
  return reply;
}

function messagePartsJson(message: TeamcluMessage): string {
  return (message as unknown as { partsJson?: string | null }).partsJson ?? "";
}

function withPatchedToolResult(
  parts: MessagePart[],
  args: {
    toolId: string;
    success: boolean;
    summary: string;
    content?: unknown;
    rawOutput?: unknown;
  },
): MessagePart[] | null {
  const toolId = args.toolId.trim();
  if (!toolId) return null;
  let matched = false;
  const next = parts.map((part) => {
    if (part.type !== "tool-call" || !part.toolCall || part.toolCall.id !== toolId) {
      return part;
    }
    matched = true;
    const start = part.toolCall.startTime;
    const startMs =
      start instanceof Date
        ? start.getTime()
        : typeof start === "string" || typeof start === "number"
          ? new Date(start).getTime()
          : Date.now();
    const toolCall: ToolCall = {
      ...part.toolCall,
      status: args.success ? "completed" : "failed",
      result: args.summary,
      duration: Math.max(0, Date.now() - startMs),
      ...(args.content !== undefined
        ? { content: args.content as ToolCall["content"] }
        : {}),
      ...(args.rawOutput !== undefined ? { rawOutput: args.rawOutput } : {}),
    };
    return { ...part, toolCall };
  });
  return matched ? next : null;
}

/**
 * Append a late toolUse onto the already-flushed AGENT_REPLY in the message
 * store. Returns true when a new tool-call part was added.
 */
export async function patchPersistedToolUse(args: {
  sessionId: string;
  actorId: string;
  toolId: string;
  toolName: string;
  description: string;
  params: Record<string, string>;
  toolKind?: string;
  content?: ToolCallContentBlock[];
  locations?: Array<{ path: string; line?: number }>;
  acpStatus?: string;
  rawInput?: unknown;
}): Promise<boolean> {
  const flushed = getFlushedTurn(args.sessionId, args.actorId);
  if (!flushed) return false;

  const toolId = args.toolId.trim();
  if (!toolId) return false;

  const messages = useSessionMessageStore.getState().messages[args.sessionId] ?? [];
  const message = messages.find((m) => m.messageId === flushed.messageId);
  if (!message) return false;

  const parts = parsePartsJson(messagePartsJson(message));
  if (parts.some((part) => part.type === "tool-call" && part.toolCall?.id === toolId)) {
    return false;
  }

  const newToolCall: ToolCall = {
    id: toolId,
    name: args.toolName || "unknown",
    toolKind: args.toolKind || undefined,
    acpStatus: args.acpStatus,
    content: args.content,
    locations: args.locations,
    rawInput: args.rawInput,
    status: "calling",
    arguments: toolUseArguments(args.params, args.description),
    startTime: new Date(),
  };
  const nextParts: MessagePart[] = [
    ...parts,
    {
      id: `stream:tool:${toolId}`,
      type: "tool-call",
      toolCallId: toolId,
      toolCall: newToolCall,
    },
  ];

  const partsJson = JSON.stringify(nextParts);
  let enrichedPartsJson = partsJson;
  try {
    enrichedPartsJson = await setMessageParts(
      flushed.messageId,
      partsJson,
      useWorkspaceStore.getState().workspacePath,
    );
  } catch (e) {
    console.warn("[streaming-persist] late toolUse parts_json write failed:", e);
  }

  const updated = Object.assign(
    Object.create(Object.getPrototypeOf(message)),
    message,
    { partsJson: enrichedPartsJson },
  ) as TeamcluMessage;

  useSessionMessageStore
    .getState()
    .replaceTurnAgentRepliesInStore(args.sessionId, updated);
  return true;
}

/**
 * Apply a late toolResult onto the already-flushed AGENT_REPLY in the message
 * store + local cache. Returns true when a tool row was updated.
 */
export async function patchPersistedToolResult(args: {
  sessionId: string;
  actorId: string;
  toolId: string;
  success: boolean;
  summary: string;
  content?: unknown;
  rawOutput?: unknown;
}): Promise<boolean> {
  const flushed = getFlushedTurn(args.sessionId, args.actorId);
  if (!flushed) return false;

  const messages = useSessionMessageStore.getState().messages[args.sessionId] ?? [];
  const message = messages.find((m) => m.messageId === flushed.messageId);
  if (!message) return false;

  const parts = parsePartsJson(messagePartsJson(message));
  if (parts.length === 0) return false;

  const patched = withPatchedToolResult(parts, args);
  if (!patched) return false;

  const partsJson = JSON.stringify(patched);
  let enrichedPartsJson = partsJson;
  try {
    enrichedPartsJson = await setMessageParts(
      flushed.messageId,
      partsJson,
      useWorkspaceStore.getState().workspacePath,
    );
  } catch (e) {
    console.warn("[streaming-persist] late toolResult parts_json write failed:", e);
  }

  const updated = Object.assign(
    Object.create(Object.getPrototypeOf(message)),
    message,
    { partsJson: enrichedPartsJson },
  ) as TeamcluMessage;

  useSessionMessageStore
    .getState()
    .replaceTurnAgentRepliesInStore(args.sessionId, updated);
  return true;
}

/** @internal test helper */
export function transcriptPartsForTests(
  parts: MessagePart[],
  pending: TeamcluMessage[],
): { parts: MessagePart[]; content: string } {
  return {
    parts,
    content: deriveAgentReplyContent(parts, pending),
  };
}

export { joinTextPartsFromParts };
