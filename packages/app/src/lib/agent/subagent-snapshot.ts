import type { MessagePart } from "@/stores/session-types";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { snapshotTranscriptParts } from "@/lib/stream/streaming-persist";

const TOOL_TRUNCATE_BYTES = 64 * 1024;
const SNAPSHOT_MAX_BYTES = 256 * 1024;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncateText(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = "…[输出已截断]";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + marker;
    if (byteLength(candidate) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + marker;
}

function partPayloadBytes(part: MessagePart): number {
  if (part.type === "reasoning" || part.type === "text") {
    return byteLength(part.text || part.content || "");
  }
  if (part.type !== "tool-call" || !part.toolCall) return 0;
  const tc = part.toolCall;
  let total = byteLength(typeof tc.result === "string" ? tc.result : "");
  if (typeof tc.rawOutput === "string") total += byteLength(tc.rawOutput);
  else if (tc.rawOutput) total += byteLength(JSON.stringify(tc.rawOutput));
  if (Array.isArray(tc.content)) {
    for (const block of tc.content) {
      if (block && typeof block === "object" && "text" in block) {
        total += byteLength(String((block as { text?: string }).text ?? ""));
      }
    }
  }
  return total;
}

/** Truncate oversized tool outputs before persisting subagentSnapshot. */
function truncateSubagentSnapshotParts(parts: MessagePart[]): MessagePart[] {
  const truncated = parts.map((part) => {
    if (part.type !== "tool-call" || !part.toolCall) return part;
    const tc = part.toolCall;
    const next = { ...tc };
    if (typeof next.result === "string" && byteLength(next.result) > TOOL_TRUNCATE_BYTES) {
      next.result = truncateText(next.result, TOOL_TRUNCATE_BYTES);
    }
    if (typeof next.rawOutput === "string" && byteLength(next.rawOutput) > TOOL_TRUNCATE_BYTES) {
      next.rawOutput = truncateText(next.rawOutput, TOOL_TRUNCATE_BYTES);
    }
    return { ...part, toolCall: next };
  });

  let total = truncated.reduce((sum, part) => sum + partPayloadBytes(part), 0);
  if (total <= SNAPSHOT_MAX_BYTES) return truncated;

  const toolIndexes = truncated
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.type === "tool-call" && part.toolCall)
    .sort((a, b) => partPayloadBytes(b.part) - partPayloadBytes(a.part));

  const out = [...truncated];
  for (const { index } of toolIndexes) {
    if (total <= SNAPSHOT_MAX_BYTES) break;
    const part = out[index];
    if (part?.type !== "tool-call" || !part.toolCall) continue;
    const tc = { ...part.toolCall };
    if (typeof tc.result === "string") {
      tc.result = truncateText(tc.result, Math.floor(TOOL_TRUNCATE_BYTES / 2));
    }
    out[index] = { ...part, toolCall: tc };
    total = out.reduce((sum, p) => sum + partPayloadBytes(p), 0);
  }
  return out;
}

export function snapshotSubagentEntry(
  entry: AgentStreamEntry | undefined,
): MessagePart[] {
  return truncateSubagentSnapshotParts(snapshotTranscriptParts(entry));
}

export function entryFromPersistedSubagentSnapshot(
  snapshot: unknown,
): AgentStreamEntry | null {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return null;
  return {
    sessionId: "",
    actorId: "",
    outputText: "",
    thinkingText: "",
    parts: snapshot as MessagePart[],
    toolCalls: [],
    planEntries: [],
    pendingPermissionsByRequestId: {},
    errorMessage: null,
    errorDetails: null,
    lastUpdate: 0,
    active: false,
    streamId: "persisted-subagent",
  };
}
