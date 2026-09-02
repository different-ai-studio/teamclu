import {
  agentReplyTextsEquivalent,
  pickCanonicalAgentReplyText,
} from "@/lib/agent-reply-text";
import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import type { MessagePart } from "@/stores/session-types";

type TranscriptPart = {
  type?: string;
  text?: string;
  content?: string;
  /** Shape varies by source (proto, stream entry); narrowed at the use site. */
  toolCall?: unknown;
};

/**
 * Daemon English status notices stored on AGENT_REPLY for agent context /
 * catchup. Live merge and UI display must treat them as empty prose.
 */
export function isAgentFacingStatusNotice(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("[Turn interrupted by user]") ||
    trimmed.startsWith("[Turn completed with no final reply]") ||
    trimmed.startsWith("[Skill created in unsupported directory]")
  );
}

function pendingReplyProse(message: TeamcluMessage): string {
  const text = message.content?.trim() ?? "";
  if (!text || isAgentFacingStatusNotice(text)) return "";
  return text;
}

/**
 * Todo-list tools carry no answer content and agents routinely emit one *after*
 * the substantive reply to mark the work done. They must not anchor the
 * process/final boundary, or that trailing call buries the real answer inside
 * the collapsed process block.
 */
const BOOKKEEPING_TOOL_NAMES = new Set([
  "todowrite",
  "todoread",
  "todo_write",
  "todo_read",
]);

function isBookkeepingToolPart(part: TranscriptPart | undefined): boolean {
  if (part?.type !== "tool-call") return false;
  const name = (part.toolCall as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && BOOKKEEPING_TOOL_NAMES.has(name.toLowerCase());
}

/** Join ordered text parts for message.content (derived view, not a second source). */
export function joinTextPartsFromParts(parts: TranscriptPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part.text || part.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function lastTextPartIndex(parts: MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") return index;
  }
  return -1;
}

function lastToolPartIndex(parts: MessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "tool-call") return index;
  }
  return -1;
}

/** Text bodies that appear before the last tool-call boundary. */
function priorTextBodiesBeforeLastTool(parts: MessagePart[]): string[] {
  const lastToolIndex = lastToolPartIndex(parts);
  if (lastToolIndex < 0) return [];
  const end = lastToolIndex;
  return parts
    .slice(0, end + 1)
    .filter((part) => part.type === "text")
    .map((part) => (part.text || part.content || "").trim())
    .filter(Boolean);
}

/**
 * Split a completed assistant transcript into process vs final reply.
 *
 * Boundary = last non-text process activity (`reasoning` | `tool-call`), not
 * merely the last tool-call — a trailing thinking block may sit after tools
 * and before the final answer text. Bookkeeping tools are excluded from the
 * boundary but still rendered as process.
 *
 * - process: everything through that last activity (keeps interleaved mid-turn
 *   narrations in chronological order with tools/thinking), plus any
 *   bookkeeping tool calls trailing past the boundary
 * - final: trailing `text` parts after that boundary
 * - no process activity: process holds only trailing bookkeeping, all text is final
 */
export function splitAssistantProcessAndFinalParts<T extends TranscriptPart>(
  parts: T[],
): { processParts: T[]; finalTextParts: T[] } {
  let lastProcessIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const type = part?.type;
    if (type === "reasoning" || (type === "tool-call" && !isBookkeepingToolPart(part))) {
      lastProcessIndex = index;
    }
  }
  const trailing = parts.slice(lastProcessIndex + 1);
  return {
    processParts: [
      ...parts.slice(0, lastProcessIndex + 1),
      ...trailing.filter(isBookkeepingToolPart),
    ],
    finalTextParts: trailing.filter((part) => part.type === "text"),
  };
}

/**
 * When acp.output sends a cumulative chunk after tools, keep only the post-tool
 * suffix so earlier text parts are not duplicated.
 */
export function stripPriorTranscriptTextPrefix(
  parts: MessagePart[],
  candidate: string,
): string {
  if (!candidate) return "";

  const priorTexts = priorTextBodiesBeforeLastTool(parts);
  if (priorTexts.length === 0) return candidate;

  const trimmed = candidate.trim();
  if (!trimmed) return "";

  // Incremental acp.output token deltas often carry meaningful leading spaces
  // (e.g. " J", " page"). Only rewrite when we actually strip a cumulative
  // pre-tool prefix; otherwise return the delta unchanged.
  let text = trimmed;
  let strippedPrefix = false;
  for (const prior of priorTexts) {
    if (!prior) continue;
    if (text === prior || agentReplyTextsEquivalent(text, prior)) return "";
    if (text.startsWith(prior)) {
      text = text.slice(prior.length).replace(/^\s*\n+\s*/, "");
      strippedPrefix = true;
    }
  }

  const joinedPrior = priorTexts.join("\n\n");
  if (joinedPrior && text.startsWith(joinedPrior)) {
    text = text.slice(joinedPrior.length).replace(/^\s*\n+\s*/, "");
    strippedPrefix = true;
  }

  if (!strippedPrefix) return candidate;

  return text;
}

/**
 * The one place where two equivalent-after-normalization reply texts are
 * reconciled. When both bodies say the same thing, the longer one wins,
 * because MQTT QoS0 can drop post-tool deltas and the daemon's final content
 * carries that tail. CLAUDE.md's "never take the longest on completion" rule
 * has exactly this exception and only here; do not import
 * pickCanonicalAgentReplyText anywhere else (guarded by
 * agent-reply-single-reconciliation.test.ts).
 */
export function reconcileEquivalentAgentReplyText(current: string, incoming: string): string {
  return pickCanonicalAgentReplyText(current, incoming);
}

/** Derive message.content from the live transcript; pending is metadata + drift hint only. */
export function deriveAgentReplyContent(
  parts: TranscriptPart[],
  pending: TeamcluMessage[],
): string {
  const textParts = parts.filter(
    (part) => part.type === "text" && Boolean((part.text || part.content)?.trim()),
  );
  const lastPending = pending[pending.length - 1];
  const daemonFinal = lastPending ? pendingReplyProse(lastPending) : "";

  if (textParts.length === 0) {
    const joinedPending = pending
      .map((message) => pendingReplyProse(message))
      .filter(Boolean)
      .filter((text, index, all) => index === 0 || text !== all[index - 1])
      .join("\n\n");
    return joinedPending || daemonFinal;
  }

  if (textParts.length === 1) {
    const partText = (textParts[0].text || textParts[0].content || "").trim();
    if (!daemonFinal) return partText;
    const hasTools = parts.some((part) => part.type === "tool-call");
    if (
      hasTools &&
      partText &&
      !partText.includes(daemonFinal) &&
      !daemonFinal.includes(partText) &&
      !agentReplyTextsEquivalent(partText, daemonFinal)
    ) {
      return `${partText}\n\n${daemonFinal}`;
    }
    return pickCanonicalAgentReplyText(partText, daemonFinal);
  }

  if (textParts.length > 1) {
    const joined = joinTextPartsFromParts(parts);
    if (!daemonFinal) return joined;
    if (daemonFinalDuplicatesTranscript(parts as MessagePart[], daemonFinal)) return daemonFinal;
    if (joined.includes(daemonFinal) || daemonFinal.includes(joined)) {
      return pickCanonicalAgentReplyText(joined, daemonFinal);
    }
    // QoS0 may drop post-tool stream deltas; daemon final still carries that tail.
    const hasTools = parts.some((part) => part.type === "tool-call");
    if (hasTools) {
      return joined ? `${joined}\n\n${daemonFinal}` : daemonFinal;
    }
    return pickCanonicalAgentReplyText(joined, daemonFinal);
  }

  return joinTextPartsFromParts(parts);
}

/** True when daemon final text is a cumulative superset of the live transcript. */
export function daemonFinalDuplicatesTranscript(
  parts: MessagePart[],
  finalText: string,
): boolean {
  const trimmed = finalText.trim();
  if (!trimmed) return false;
  const joined = joinTextPartsFromParts(parts);
  if (!joined) return false;
  if (trimmed === joined) return true;
  if (trimmed.startsWith(joined) && /^[\s\n]/.test(trimmed.slice(joined.length))) {
    return true;
  }
  const priorTexts = priorTextBodiesBeforeLastTool(parts);
  if (priorTexts.length === 0) return false;
  const first = priorTexts[0];
  return Boolean(first && trimmed.startsWith(first) && trimmed.length > first.length);
}

/** Update only the last post-tool text part when finalText is a terminal slice. */
export function replaceLastPostToolTextPart(
  parts: MessagePart[],
  finalText: string,
): MessagePart[] {
  const lastToolIndex = lastToolPartIndex(parts);
  if (lastToolIndex < 0) return parts;

  const slice = stripPriorTranscriptTextPrefix(parts, finalText);
  if (!slice) return parts;

  let lastPostToolText = -1;
  for (let index = parts.length - 1; index > lastToolIndex; index -= 1) {
    if (parts[index]?.type === "text") {
      lastPostToolText = index;
      break;
    }
  }

  if (lastPostToolText === -1) return parts;

  return parts.map((part, index) =>
    index === lastPostToolText
      ? { ...part, text: slice, content: slice }
      : part,
  );
}

export function reconcileSingleSegmentDrift(
  parts: MessagePart[],
  finalText: string,
): MessagePart[] {
  const lastTextIndex = lastTextPartIndex(parts);
  if (lastTextIndex === -1) return parts;
  const canonical = pickCanonicalAgentReplyText(
    (parts[lastTextIndex].text || parts[lastTextIndex].content || "").trim(),
    finalText.trim(),
  );
  return parts.map((part, index) =>
    index === lastTextIndex ? { ...part, text: canonical, content: canonical } : part,
  );
}
