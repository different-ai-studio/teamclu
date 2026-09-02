/**
 * Turning a stream of deltas into a coherent `MessagePart[]`.
 *
 * Text merging (overlap-stripping on resume, post-tool text placement) and
 * tool-call reconciliation (placeholders, revival, enriched-part merging,
 * preview updates). Pure data transformation: no store access, and — checked
 * when this was split out — no module-level mutable state, so nothing is
 * shared across the boundary.
 *
 * The only edge back to the store is the `AgentStreamEntry` type below, which
 * is erased at compile time. The store re-exports the two names that were part
 * of its public surface, so existing import sites are unchanged.
 */
import { stripPriorTranscriptTextPrefix } from "@/lib/agent-reply-transcript";
import { agentReplyBodiesCollapsible, agentReplyTextsEquivalent } from "@/lib/agent-reply-text";
import { reconcileEquivalentAgentReplyText } from "@/lib/agent-reply-transcript";
import type { MessagePart, ToolCall } from "@/stores/session-types";
import type { ToolCallContentBlock } from "@/components/chat/tool-calls/tool-call-content";
// Type-only: erased at runtime, so this is not an import cycle.
import type { AgentStreamEntry } from "./v2-streaming-store";

export function entryParts(entry: AgentStreamEntry): MessagePart[] {
  return Array.isArray(entry.parts) ? entry.parts : [];
}

// Overlap-strip merge: drops the longest prefix of `chunk` that equals a
// suffix of `existing`. This is ONLY correct for daemon RESUME/replay re-sends
// (commit 64750570), which re-emit already-seen transcript with NEW eventIds so
// the eventId dedup (rememberLiveEventId in App.tsx) can't catch them. Normal
// LIVE deltas are already eventId-deduped upstream, so they must use plain
// concatenation — otherwise genuinely repeated content ("test " + "test ",
// "\n\n" + "\n\n") gets swallowed and the loss is persisted. Callers therefore
// pass mergeOverlap=false on the live-append path.
export function appendOverlappingChunk(existing: string, chunk: string): string {
  if (!existing || !chunk) return existing + chunk;
  const maxOverlap = Math.min(existing.length, chunk.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (existing.endsWith(chunk.slice(0, length))) {
      return existing + chunk.slice(length);
    }
  }
  return existing + chunk;
}

export function mergeChunk(existing: string, chunk: string, mergeOverlap: boolean): string {
  return mergeOverlap ? appendOverlappingChunk(existing, chunk) : existing + chunk;
}

export function appendTextPart(
  parts: MessagePart[],
  delta: string,
  mergeOverlap = true,
): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    const text = mergeChunk(last.text || last.content || "", delta, mergeOverlap);
    return [
      ...parts.slice(0, -1),
      {
        ...last,
        text,
        content: text,
      },
    ];
  }
  return [
    ...parts,
    {
      id: `stream:text:${Date.now()}:${parts.length}`,
      type: "text",
      text: delta,
      content: delta,
    },
  ];
}

export function appendOutputToParts(
  parts: MessagePart[],
  delta: string,
  mergeOverlap = true,
): MessagePart[] {
  const segmentDelta = stripPriorTranscriptTextPrefix(parts, delta);
  if (!segmentDelta) return parts;
  return appendTextPart(parts, segmentDelta, mergeOverlap);
}

export function appendReasoningPart(
  parts: MessagePart[],
  delta: string,
  mergeOverlap = true,
): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.type === "reasoning") {
    const text = mergeChunk(last.text || last.content || "", delta, mergeOverlap);
    return [
      ...parts.slice(0, -1),
      {
        ...last,
        text,
        content: text,
      },
    ];
  }
  return [
    ...parts,
    {
      id: `stream:reasoning:${Date.now()}:${parts.length}`,
      type: "reasoning",
      text: delta,
      content: delta,
    },
  ];
}

function replacePartText(part: MessagePart, text: string): MessagePart {
  return {
    ...part,
    text,
    content: text,
  };
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function hasTextAfterLastTool(parts: MessagePart[]): boolean {
  const lastToolIndex = lastIndexWhere(parts, (part) => part.type === "tool-call");
  if (lastToolIndex === -1) return false;
  return parts.some(
    (part, index) => index > lastToolIndex && part.type === "text",
  );
}

function replacePostToolTextPart(parts: MessagePart[], text: string): MessagePart[] {
  const lastToolIndex = lastIndexWhere(parts, (part) => part.type === "tool-call");
  if (lastToolIndex === -1) return appendTextPart(parts, text);

  const prefix = parts.slice(0, lastToolIndex + 1);
  const tail = parts.slice(lastToolIndex + 1);
  const firstTextIdx = tail.findIndex((part) => part.type === "text");
  if (firstTextIdx === -1) return placePostToolTextPart(parts, text);

  // Multiple non-cumulative AGENT_REPLY previews append several text parts
  // after the last tool; finalize must collapse them to a single final text.
  const beforeText = tail.slice(0, firstTextIdx);
  const consolidated = replacePartText(tail[firstTextIdx], text);
  const afterText = tail.slice(firstTextIdx + 1).filter((part) => part.type !== "text");
  return [...prefix, ...beforeText, consolidated, ...afterText];
}

function placePostToolTextPart(parts: MessagePart[], text: string): MessagePart[] {
  const lastToolIndex = lastIndexWhere(parts, (part) => part.type === "tool-call");
  if (lastToolIndex === -1) return appendTextPart(parts, text);

  const existingTextIndex = parts.findIndex(
    (part, index) => index > lastToolIndex && part.type === "text",
  );
  if (existingTextIndex !== -1) {
    const existing = parts[existingTextIndex];
    const existingText = existing.text || existing.content || "";
    if (
      existingText === text ||
      existingText.includes(text) ||
      agentReplyTextsEquivalent(existingText, text)
    ) {
      return parts;
    }
    if (text.includes(existingText)) {
      return parts.map((part, index) =>
        index === existingTextIndex ? replacePartText(part, text) : part,
      );
    }
    return [
      ...parts,
      {
        id: `stream:text:reply-preview:${Date.now()}:${parts.length}`,
        type: "text",
        text,
        content: text,
      },
    ];
  }

  const toolPart = parts[lastToolIndex];
  const previewId = `stream:text:reply-preview:${toolPart.toolCallId || toolPart.id}`;
  return [
    ...parts,
    {
      id: previewId,
      type: "text",
      text,
      content: text,
    },
  ];
}

export function withCompletedTool(
  toolCalls: ToolCall[],
  toolId: string,
  success: boolean,
  summary: string,
  content?: ToolCallContentBlock[],
  rawOutput?: unknown,
): ToolCall[] {
  return toolCalls.map((tc) =>
    tc.id === toolId
      ? {
          ...tc,
          status: success ? ("completed" as const) : ("failed" as const),
          result: summary,
          duration: Date.now() - tc.startTime.getTime(),
          ...(content !== undefined ? { content } : {}),
          ...(rawOutput !== undefined ? { rawOutput } : {}),
        }
      : tc,
  );
}

export function completedToolPlaceholder(
  toolId: string,
  success: boolean,
  summary: string,
): ToolCall {
  return {
    id: toolId,
    name: "unknown",
    status: success ? "completed" : "failed",
    arguments: {},
    result: summary,
    duration: 0,
    startTime: new Date(),
  };
}

export function toolCallPart(toolCall: ToolCall): MessagePart {
  return {
    id: `stream:tool:${toolCall.id}`,
    type: "tool-call",
    toolCallId: toolCall.id,
    toolCall,
  };
}

export function syncToolParts(parts: MessagePart[], toolCalls: ToolCall[]): MessagePart[] {
  const byId = new Map(toolCalls.map((tc) => [tc.id, tc]));
  return parts.map((part) => {
    if (part.type !== "tool-call" || !part.toolCallId) return part;
    const toolCall = byId.get(part.toolCallId);
    return toolCall ? { ...part, toolCall } : part;
  });
}

function reviveToolCall(toolCall: ToolCall): ToolCall {
  const rawStartTime = toolCall.startTime as unknown;
  return {
    ...toolCall,
    startTime:
      rawStartTime instanceof Date
        ? rawStartTime
        : typeof rawStartTime === "string" || typeof rawStartTime === "number"
          ? new Date(rawStartTime)
          : new Date(),
  };
}

export function reviveToolCallPart(part: MessagePart): MessagePart {
  if (part.type !== "tool-call" || !part.toolCall) return part;
  return {
    ...part,
    toolCall: reviveToolCall(part.toolCall),
  };
}

/** Async enrich/replaceParts can carry stale tool-call rows captured mid-turn.
 * Never downgrade a terminal live status back to calling/waiting. */
export function mergeToolCallFromEnrichedParts(
  existing: ToolCall,
  enriched: ToolCall,
): ToolCall {
  const terminal = existing.status === "completed" || existing.status === "failed";
  const enrichedInFlight =
    enriched.status === "calling" || enriched.status === "waiting";
  if (terminal && enrichedInFlight) {
    return {
      ...enriched,
      status: existing.status,
      result: existing.result ?? enriched.result,
      duration: existing.duration ?? enriched.duration,
    };
  }
  return enriched;
}

/** Mark in-flight tools failed so idle flush / reload never leave a spinner. */
export function finishUnresolvedTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((tc) => {
    if (tc.status !== "calling" && tc.status !== "waiting") return tc;
    return {
      ...tc,
      status: "failed" as const,
      result: "Stream ended before this tool returned a result.",
      duration: Date.now() - tc.startTime.getTime(),
    };
  });
}

/** Sync tool-call parts to match toolCalls (exported for persist finalize). */
export function syncToolPartsForPersist(
  parts: MessagePart[],
  toolCalls: ToolCall[],
): MessagePart[] {
  return syncToolParts(parts, toolCalls);
}

export function toolUseArguments(
  params: Record<string, string>,
  description: string,
): Record<string, unknown> {
  return {
    ...(params ?? {}),
    ...(description ? { _description: description } : {}),
  };
}

export function mergeToolUse(
  existing: ToolCall,
  args: {
    toolName: string;
    description: string;
    params: Record<string, string>;
    toolKind?: string;
    content?: ToolCallContentBlock[];
    locations?: Array<{ path: string; line?: number }>;
    acpStatus?: string;
    rawInput?: unknown;
  },
): ToolCall {
  const nextArgs = toolUseArguments(args.params, args.description);
  const incomingName = args.toolName?.trim();
  const name =
    incomingName && incomingName !== "unknown"
      ? incomingName
      : existing.name || "unknown";
  return {
    ...existing,
    name,
    toolKind: args.toolKind || existing.toolKind,
    acpStatus: args.acpStatus || existing.acpStatus,
    ...(args.content !== undefined ? { content: args.content } : {}),
    ...(args.locations !== undefined ? { locations: args.locations } : {}),
    ...(args.rawInput !== undefined ? { rawInput: args.rawInput } : {}),
    arguments: {
      ...(existing.arguments ?? {}),
      ...nextArgs,
    },
  };
}

function reconcileEquivalentPreviewParts(
  parts: MessagePart[],
  outputText: string,
): MessagePart[] {
  if (parts.some((part) => part.type === "tool-call")) {
    return replacePostToolTextPart(parts, outputText);
  }
  const lastTextIndex = lastIndexWhere(parts, (part) => part.type === "text");
  if (lastTextIndex === -1) return appendTextPart(parts, outputText);
  return parts.map((part, index) =>
    index === lastTextIndex ? replacePartText(part, outputText) : part,
  );
}

export function previewTextUpdate(
  entry: AgentStreamEntry,
  text: string,
): { outputText: string; parts: MessagePart[] } {
  const current = entry.outputText || "";
  const parts = entryParts(entry);

  if (!text) {
    return { outputText: current, parts };
  }
  if (
    text === current ||
    current.includes(text) ||
    agentReplyTextsEquivalent(current, text) ||
    agentReplyBodiesCollapsible(current, text)
  ) {
    const outputText = reconcileEquivalentAgentReplyText(current, text);
    if (outputText === current) return { outputText: current, parts };
    return {
      outputText,
      parts: reconcileEquivalentPreviewParts(parts, outputText),
    };
  }
  if (text.startsWith(current)) {
    const suffix = text.slice(current.length);
    if (!suffix || agentReplyTextsEquivalent(current, text)) {
      return {
        outputText: text,
        parts: reconcileEquivalentPreviewParts(parts, text),
      };
    }
    return {
      outputText: text,
      parts: suffix ? appendTextPart(parts, suffix) : parts,
    };
  }
  if (current.length === 0) {
    return {
      outputText: text,
      parts: appendTextPart(parts, text),
    };
  }

  // Last-resort mismatch: daemon may emit multiple non-cumulative AGENT_REPLY
  // chunks (e.g. CPU then memory). Append distinct segments instead of
  // replacing earlier preview text.
  const postToolTextExists = hasTextAfterLastTool(parts);
  const mergedOutput =
    postToolTextExists &&
    current &&
    text !== current &&
    !current.includes(text) &&
    !text.includes(current)
      ? `${current}\n\n${text}`
      : text;
  return {
    outputText: mergedOutput,
    parts: parts.some((part) => part.type === "tool-call")
      ? placePostToolTextPart(parts, text)
      : parts.some((part) => part.type === "text")
        ? appendTextPart(parts, text)
        : appendTextPart(parts, text),
  };
}
