// v2 → SDK message-shape adapter. The legacy MessageList expects the
// OpenCode SDK Message shape (id, role, parts[], toolCalls, timestamp,
// etc). v2 stores Teamclu_Message (proto) in `useSessionStore.messages`.
//
// In addition to shape adaptation, this module groups consecutive
// same-turn agent messages into ONE SdkMessage so that the daemon's
// per-ACP-block firehose (one thinking row, one tool_call row, one
// tool_result row, one or more agent_reply rows — all sharing a
// turn_id) renders as a single coherent agent bubble.

import { splitAssistantProcessAndFinalParts } from "@/lib/agent-reply-transcript";
import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import { MessageKind } from "@/lib/proto/teamclu_pb";
import type {
  Message as SdkMessage,
  MessagePart,
  ToolCall,
} from "@/stores/session-types";
import { parseToolContentBlocks } from "@/components/chat/tool-calls/tool-call-content";

function kindToRole(kind: MessageKind): SdkMessage["role"] {
  switch (kind) {
    case MessageKind.SYSTEM:
      return "system";
    case MessageKind.AGENT_THINKING:
    case MessageKind.AGENT_TOOL_CALL:
    case MessageKind.AGENT_TOOL_RESULT:
    case MessageKind.AGENT_REPLY:
      return "assistant";
    case MessageKind.TEXT:
    default:
      return "user";
  }
}

/** 1:1 mapping (legacy path) for messages without a turn_id or for
 * non-assistant roles. */
function parseMentionDeliverySnapshot(
  m: TeamcluMessage,
): SdkMessage["mentionDeliverySnapshot"] {
  const md = parseMetadata(m);
  const raw = md.mention_delivery_snapshot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: NonNullable<SdkMessage["mentionDeliverySnapshot"]> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (v === "ready" || v === "offline" || v === "stale") out[id] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function adaptTeamcluMessageToSdk(m: TeamcluMessage): SdkMessage {
  const mentionActorIds = parseDisplayMentionActorIds(m);
  const mentionDeliverySnapshot = parseMentionDeliverySnapshot(m);
  const replyTo = m.replyToMessageId?.trim() || undefined;
  const turnId = m.turnId?.trim() || undefined;
  const interrupted = isInterruptedReply(m);
  const noFinalReply = isNoFinalReply(m);
  const unsupportedNativeSkill = isUnsupportedNativeSkillReply(m);
  const nativeSkillViolations = unsupportedNativeSkill
    ? parseNativeSkillViolations(m)
    : undefined;
  const displayContent = displayContentForReply(m);
  return {
    id: m.messageId,
    sessionId: m.sessionId,
    senderActorId: m.senderActorId,
    role: kindToRole(m.kind),
    // Keep generated prose; only hide English agent-facing status notices.
    content: displayContent,
    mentionActorIds,
    mentionDeliverySnapshot,
    modelID: m.model || undefined,
    replyToMessageId: replyTo,
    turnId,
    turnStatus: interrupted
      ? "interrupted"
      : noFinalReply
        ? "no_final_reply"
        : unsupportedNativeSkill
          ? "skill_created_in_unsupported_directory"
          : undefined,
    nativeSkillViolations,
    parts: displayContent
      ? [
          {
            id: `${m.messageId}-p0`,
            type: "text",
            text: displayContent,
            content: displayContent,
          },
        ]
      : [],
    toolCalls: [],
    timestamp: new Date(Number(m.createdAt) * 1000),
  };
}

function parseMetadata(m: TeamcluMessage): Record<string, unknown> {
  try {
    return m.metadataJson ? (JSON.parse(m.metadataJson) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isInterruptedReply(m: TeamcluMessage): boolean {
  return parseMetadata(m).turn_status === "interrupted";
}

function isNoFinalReply(m: TeamcluMessage): boolean {
  if (parseMetadata(m).turn_status === "no_final_reply") return true;
  return isAgentFacingNoFinalReplyNotice(m.content ?? "");
}

function isUnsupportedNativeSkillReply(m: TeamcluMessage): boolean {
  return parseMetadata(m).turn_status === "skill_created_in_unsupported_directory";
}

function parseNativeSkillViolations(
  m: TeamcluMessage,
): { slug: string; root: string; path?: string }[] {
  const raw = parseMetadata(m).violations;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v))
    .map((v) => ({
      slug: typeof v.slug === "string" ? v.slug : "",
      root: typeof v.root === "string" ? v.root : "",
      path: typeof v.path === "string" ? v.path : undefined,
    }))
    .filter((v) => v.slug.length > 0 && v.root.length > 0);
}

/** Daemon English instruction when there was no prose to keep. */
function isAgentFacingInterruptNotice(content: string): boolean {
  return content.trimStart().startsWith("[Turn interrupted by user]");
}

function isAgentFacingNoFinalReplyNotice(content: string): boolean {
  return content.trimStart().startsWith("[Turn completed with no final reply]");
}

function isAgentFacingUnsupportedNativeSkillNotice(content: string): boolean {
  return content.trimStart().startsWith("[Skill created in unsupported directory]");
}

/** User-visible body for an AGENT_REPLY (hide agent-facing status notices). */
function displayContentForReply(m: TeamcluMessage): string {
  const raw = m.content ?? "";
  if (
    isAgentFacingInterruptNotice(raw) ||
    isAgentFacingNoFinalReplyNotice(raw) ||
    isAgentFacingUnsupportedNativeSkillNotice(raw)
  ) {
    return "";
  }
  return raw;
}

function turnStatusFromReplies(
  replies: TeamcluMessage[],
):
  | "interrupted"
  | "no_final_reply"
  | "skill_created_in_unsupported_directory"
  | undefined {
  if (replies.some(isInterruptedReply)) return "interrupted";
  if (replies.some(isUnsupportedNativeSkillReply)) {
    return "skill_created_in_unsupported_directory";
  }
  if (replies.some(isNoFinalReply)) return "no_final_reply";
  return undefined;
}

function nativeSkillViolationsFromReplies(
  replies: TeamcluMessage[],
): { slug: string; root: string; path?: string }[] | undefined {
  for (const reply of replies) {
    if (isUnsupportedNativeSkillReply(reply)) {
      const parsed = parseNativeSkillViolations(reply);
      if (parsed.length > 0) return parsed;
    }
  }
  return undefined;
}

function parseDisplayMentionActorIds(m: TeamcluMessage): string[] {
  const md = parseMetadata(m);
  const raw = md.display_mention_actor_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function partsJson(m: TeamcluMessage): string {
  return (m as unknown as { partsJson?: string | null }).partsJson ?? "";
}

function reviveToolCallDates(toolCall: ToolCall): ToolCall {
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

function parsePartsJson(json: string): MessagePart[] {
  try {
    const parsed = JSON.parse(json) as MessagePart[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((part) => part && typeof part === "object" && typeof part.type === "string")
      .map((part) =>
        part.type === "tool-call" && part.toolCall
          ? { ...part, toolCall: reviveToolCallDates(part.toolCall) }
          : part,
      );
  } catch {
    return [];
  }
}

function partText(part: MessagePart): string {
  return (part.text || part.content || "").trim();
}

/** Merge ordered per-reply parts_json slices from the same turn (reload path). */
function mergeTurnPartsFromReplies(replies: TeamcluMessage[]): MessagePart[] {
  const sorted = [...replies].sort(compareTeamcluMessages);
  const out: MessagePart[] = [];
  const toolIndexById = new Map<string, number>();

  for (const reply of sorted) {
    const json = partsJson(reply);
    if (!json.trim()) continue;
    for (const part of parsePartsJson(json)) {
      if (part.type === "tool-call" && part.toolCall) {
        const toolId = part.toolCall.id;
        const existingIndex = toolIndexById.get(toolId);
        if (existingIndex !== undefined) {
          out[existingIndex] = part;
          continue;
        }
        toolIndexById.set(toolId, out.length);
        out.push(part);
        continue;
      }
      if (part.type === "reasoning") {
        const text = partText(part);
        if (!text) continue;
        const last = out[out.length - 1];
        if (last?.type === "reasoning") {
          const merged = `${partText(last)}\n\n${text}`.trim();
          out[out.length - 1] = { ...last, text: merged, content: merged };
        } else {
          out.push(part);
        }
        continue;
      }
      if (part.type === "text") {
        const text = partText(part);
        if (!text) continue;
        const last = out[out.length - 1];
        if (last?.type === "text" && partText(last) === text) continue;
        out.push(part);
      }
    }
  }

  return out;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseMetadataLocations(value: unknown): Array<{ path: string; line?: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ path: string; line?: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const loc = item as Record<string, unknown>;
    const path = String(loc.path ?? "");
    if (!path) continue;
    const line = typeof loc.line === "number" ? loc.line : undefined;
    out.push({ path, line });
  }
  return out.length > 0 ? out : undefined;
}

function parseMetadataContent(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return parseToolContentBlocks(value);
}

function paramsFromDescription(description: string): Record<string, unknown> {
  if (!description) return {};
  if (!description.trim().startsWith("{")) {
    return { _description: description };
  }
  try {
    const parsed = JSON.parse(description) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { _description: description };
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
  } catch {
    return { _description: description };
  }
}

function paramsFromMetadataParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => [
      key,
      typeof raw === "string" ? raw : JSON.stringify(raw),
    ]),
  );
}

function optionalOrder(m: TeamcluMessage): bigint | null {
  const maybe = m as unknown as {
    sequence?: bigint | number | string;
    order?: bigint | number | string;
    orderIndex?: bigint | number | string;
  };
  const raw = maybe.sequence ?? maybe.order ?? maybe.orderIndex;
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function compareBigInt(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareTeamcluMessages(a: TeamcluMessage, b: TeamcluMessage): number {
  const aOrder = optionalOrder(a);
  const bOrder = optionalOrder(b);
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) {
    return compareBigInt(aOrder, bOrder);
  }
  if (aOrder !== null && bOrder === null) return -1;
  if (aOrder === null && bOrder !== null) return 1;

  // `createdAt` is whole seconds, so a gateway user message and the reply
  // written right after it tie. Returning 0 keeps the caller's order (sort is
  // stable); tiebreaking on `messageId` would compare a WeCom `msgid` against a
  // random UUID and reorder the pair arbitrarily.
  return compareBigInt(a.createdAt, b.createdAt);
}

/** Prefer the first non-empty reply_to on a same-turn group. */
function firstNonEmptyReplyToMessageId(group: TeamcluMessage[]): string | undefined {
  for (const message of group) {
    const id = message.replyToMessageId?.trim();
    if (id) return id;
  }
  return undefined;
}

/** Collapse a run of consecutive same-(senderActorId, turnId) assistant
 * messages into one SdkMessage. Thinking → reasoning part. Tool calls →
 * toolCalls[] matched with results by metadata.tool_id. Replies →
 * concatenated content. */
export function buildFullTurnSdkMessageFromGroup(group: TeamcluMessage[]): SdkMessage {
  const thinking = group.filter((m) => m.kind === MessageKind.AGENT_THINKING);
  const toolCallProtos = group.filter((m) => m.kind === MessageKind.AGENT_TOOL_CALL);
  const toolResultProtos = group.filter((m) => m.kind === MessageKind.AGENT_TOOL_RESULT);
  const replies = group.filter((m) => m.kind === MessageKind.AGENT_REPLY);

  const resultByToolId = new Map<
    string,
    {
      success: boolean;
      summary: string;
      content?: ReturnType<typeof parseToolContentBlocks>;
      rawOutput?: unknown;
    }
  >();
  for (const r of toolResultProtos) {
    const md = parseMetadata(r);
    const toolId = String(md.tool_id ?? "");
    if (toolId) {
      resultByToolId.set(toolId, {
        success: Boolean(md.success),
        summary: r.content,
        content: parseMetadataContent(md.content),
        rawOutput: parseJsonValue(md.raw_output_json),
      });
    }
  }

  const toolCalls: ToolCall[] = toolCallProtos.map((tc) => {
    const md = parseMetadata(tc);
    const toolId = String(md.tool_id ?? "");
    const toolNameRaw = String(md.tool_name ?? "unknown");
    const toolKind =
      typeof md.tool_kind === "string"
        ? md.tool_kind
        : typeof md.toolKind === "string"
          ? md.toolKind
          : undefined;
    const description = String(md.description ?? "");
    const args = {
      ...paramsFromDescription(description),
      ...paramsFromMetadataParams(md.params),
    };
    const match = toolId ? resultByToolId.get(toolId) : undefined;
    const acpStatus =
      typeof md.status === "string" && md.status.trim() ? md.status : undefined;
    const toolUseContent = parseMetadataContent(md.content);
    return {
      id: toolId || tc.messageId,
      name: toolNameRaw,
      toolKind,
      acpStatus,
      content: match?.content ?? toolUseContent,
      locations: parseMetadataLocations(md.locations),
      rawInput: parseJsonValue(md.raw_input_json),
      status: match ? (match.success ? "completed" : "failed") : "calling",
      arguments: args,
      startTime: new Date(Number(tc.createdAt) * 1000),
      result: match ? match.summary : undefined,
      ...(match?.rawOutput !== undefined ? { rawOutput: match.rawOutput } : {}),
    };
  });
  const toolCallByMessageId = new Map<string, ToolCall>();
  toolCallProtos.forEach((proto, index) => {
    const toolCall = toolCalls[index];
    if (!toolCall) return;
    toolCallByMessageId.set(proto.messageId, toolCall);
  });

  // Legacy desktop builds wrote live-cache rows before Supabase generated a
  // different id for the same reply. Collapse those exact same-turn echoes.
  const uniqueReplies: TeamcluMessage[] = [];
  const uniqueReplyIds = new Set<string>();
  const replyIndexByKey = new Map<string, number>();
  for (const reply of replies) {
    const key = `${reply.content}\u0000${reply.model}`;
    const existingIndex = replyIndexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = uniqueReplies[existingIndex];
      if (!partsJson(existing) && partsJson(reply)) {
        uniqueReplyIds.delete(existing.messageId);
        uniqueReplies[existingIndex] = reply;
        uniqueReplyIds.add(reply.messageId);
      }
      continue;
    }
    replyIndexByKey.set(key, uniqueReplies.length);
    uniqueReplies.push(reply);
    uniqueReplyIds.add(reply.messageId);
  }
  const turnStatus = turnStatusFromReplies(uniqueReplies);
  const nativeSkillViolations = nativeSkillViolationsFromReplies(uniqueReplies);
  const replyText = uniqueReplies
    .map((r) => displayContentForReply(r))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  const thinkingText = thinking.map((t) => t.content).join("\n");

  const groupId =
    uniqueReplies.find((r) => displayContentForReply(r).trim())?.messageId ??
    uniqueReplies[0]?.messageId ??
    group[0].messageId;
  const repliesWithParts = uniqueReplies.filter((reply) => partsJson(reply).trim());
  const mergedPersistedParts =
    repliesWithParts.length > 1
      ? mergeTurnPartsFromReplies(repliesWithParts)
      : repliesWithParts.length === 1
        ? parsePartsJson(partsJson(repliesWithParts[0]!))
        : [];

  if (mergedPersistedParts.length > 0) {
    const canonicalReply = uniqueReplies[uniqueReplies.length - 1]!;
    const canonicalToolCalls = mergedPersistedParts
      .filter((part) => part.type === "tool-call" && part.toolCall)
      .map((part) => part.toolCall!);
    const canonicalModelID =
      canonicalReply.model ||
      uniqueReplies[uniqueReplies.length - 1]?.model ||
      group.find((m) => m.model)?.model ||
      undefined;
    const partsText = mergedPersistedParts
      .filter((part) => part.type === "text")
      .map((part) => part.text || part.content || "")
      .filter(Boolean)
      .join("\n\n");
    return {
      id: canonicalReply.messageId,
      sessionId: canonicalReply.sessionId,
      senderActorId: canonicalReply.senderActorId,
      role: "assistant",
      content: replyText || partsText,
      modelID: canonicalModelID,
      parts: mergedPersistedParts,
      toolCalls: canonicalToolCalls,
      replyToMessageId: firstNonEmptyReplyToMessageId(group),
      turnId: group[0]?.turnId?.trim() || undefined,
      turnStatus,
      nativeSkillViolations,
      timestamp: new Date(Number(group[0].createdAt) * 1000),
    };
  }

  const canonicalReply = [...uniqueReplies]
    .reverse()
    .find((reply) => partsJson(reply));
  if (canonicalReply) {
    const canonicalParts = parsePartsJson(partsJson(canonicalReply));
    if (canonicalParts.length > 0) {
      const canonicalToolCalls = canonicalParts
        .filter((part) => part.type === "tool-call" && part.toolCall)
        .map((part) => part.toolCall!);
      const canonicalText = canonicalParts
        .filter((part) => part.type === "text")
        .map((part) => part.text || part.content || "")
        .filter(Boolean)
        .join("\n\n");
      const canonicalModelID =
        canonicalReply.model ||
        uniqueReplies[uniqueReplies.length - 1]?.model ||
        group.find((m) => m.model)?.model ||
        undefined;
      return {
        id: canonicalReply.messageId,
        sessionId: canonicalReply.sessionId,
        senderActorId: canonicalReply.senderActorId,
        role: "assistant",
        content: replyText || canonicalText,
        modelID: canonicalModelID,
        parts: canonicalParts,
        toolCalls: canonicalToolCalls,
        replyToMessageId: firstNonEmptyReplyToMessageId(group),
        turnId: group[0]?.turnId?.trim() || undefined,
        turnStatus,
        nativeSkillViolations,
        timestamp: new Date(Number(group[0].createdAt) * 1000),
      };
    }
  }

  const parts: MessagePart[] = [];
  if (thinkingText) {
    parts.push({
      id: `${groupId}-r0`,
      type: "reasoning",
      text: thinkingText,
      content: thinkingText,
    });
  }
  if (toolCalls.length > 0) {
    let textPartIndex = 0;
    for (const item of group) {
      if (item.kind === MessageKind.AGENT_REPLY && uniqueReplyIds.has(item.messageId)) {
        const text = displayContentForReply(item);
        if (!text) continue;
        parts.push({
          id: `${item.messageId}-p${textPartIndex++}`,
          type: "text",
          text,
          content: text,
        });
      } else if (item.kind === MessageKind.AGENT_TOOL_CALL) {
        const toolCall = toolCallByMessageId.get(item.messageId);
        if (!toolCall) continue;
        parts.push({
          id: `${item.messageId}-tool`,
          type: "tool-call",
          toolCallId: toolCall.id,
          toolCall,
        });
      }
    }
  } else if (replyText) {
    parts.push({
      id: `${groupId}-p0`,
      type: "text",
      text: replyText,
      content: replyText,
    });
  }

  // model: prefer last reply (most recent decision), fall back to any
  // message that carries one.
  const modelID =
    uniqueReplies[uniqueReplies.length - 1]?.model ||
    group.find((m) => m.model)?.model ||
    undefined;

  return {
    id: groupId,
    sessionId: group[0].sessionId,
    senderActorId: group[0].senderActorId,
    role: "assistant",
    content: replyText,
    modelID,
    parts,
    toolCalls,
    replyToMessageId: firstNonEmptyReplyToMessageId(group),
    turnId: group[0]?.turnId?.trim() || undefined,
    turnStatus,
    nativeSkillViolations,
    timestamp: new Date(Number(group[0].createdAt) * 1000),
  };
}

function countTurnProcessMeta(group: TeamcluMessage[]): {
  toolCount: number;
  hasThinking: boolean;
} {
  const toolCount = group.filter((m) => m.kind === MessageKind.AGENT_TOOL_CALL).length;
  const hasThinking = group.some(
    (m) => m.kind === MessageKind.AGENT_THINKING && (m.content ?? "").trim().length > 0,
  );
  return { toolCount, hasThinking };
}

function isTurnCompleteForProcessDefer(group: TeamcluMessage[]): boolean {
  const replies = group.filter((m) => m.kind === MessageKind.AGENT_REPLY);
  if (replies.some((r) => partsJson(r).trim())) return true;

  const toolCalls = group.filter((m) => m.kind === MessageKind.AGENT_TOOL_CALL);
  if (toolCalls.length === 0) return true;

  const results = group.filter((m) => m.kind === MessageKind.AGENT_TOOL_RESULT);
  if (results.length >= toolCalls.length) return true;

  for (const tc of toolCalls) {
    const md = parseMetadata(tc);
    const status = String(md.status ?? "").toLowerCase();
    if (status === "pending" || status === "in_progress" || status === "in progress") {
      return false;
    }
  }

  return replies.some((r) => displayContentForReply(r).trim().length > 0);
}

function shouldDeferProcessParts(group: TeamcluMessage[]): boolean {
  const meta = countTurnProcessMeta(group);
  if (meta.toolCount === 0 && !meta.hasThinking) return false;
  if (!isTurnCompleteForProcessDefer(group)) return false;

  const finalParts = extractFinalTextPartsForDeferredTurn(group);
  const hasFinalText = finalParts.some((p) => (p.text || p.content || "").trim());
  if (!hasFinalText) return false;

  return true;
}

function extractFinalTextPartsForDeferredTurn(group: TeamcluMessage[]): MessagePart[] {
  const replies = group.filter((m) => m.kind === MessageKind.AGENT_REPLY);
  const uniqueReplies: TeamcluMessage[] = [];
  const uniqueReplyIds = new Set<string>();
  const replyIndexByKey = new Map<string, number>();
  for (const reply of replies) {
    const key = `${reply.content}\u0000${reply.model}`;
    const existingIndex = replyIndexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = uniqueReplies[existingIndex];
      if (!partsJson(existing) && partsJson(reply)) {
        uniqueReplyIds.delete(existing.messageId);
        uniqueReplies[existingIndex] = reply;
        uniqueReplyIds.add(reply.messageId);
      }
      continue;
    }
    replyIndexByKey.set(key, uniqueReplies.length);
    uniqueReplies.push(reply);
    uniqueReplyIds.add(reply.messageId);
  }

  const repliesWithParts = uniqueReplies.filter((reply) => partsJson(reply).trim());
  const mergedPersistedParts =
    repliesWithParts.length > 1
      ? mergeTurnPartsFromReplies(repliesWithParts)
      : repliesWithParts.length === 1
        ? parsePartsJson(partsJson(repliesWithParts[0]!))
        : [];

  if (mergedPersistedParts.length > 0) {
    const renderable = mergedPersistedParts.filter(
      (p) =>
        (p.type === "reasoning" && Boolean(p.text || p.content)) ||
        (p.type === "text" && Boolean(p.text || p.content)) ||
        (p.type === "tool-call" && Boolean(p.toolCall)),
    );
    const { finalTextParts } = splitAssistantProcessAndFinalParts(renderable);
    if (finalTextParts.length > 0) return finalTextParts;
  }

  const replyText = uniqueReplies
    .map((r) => displayContentForReply(r))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  const groupId =
    uniqueReplies.find((r) => displayContentForReply(r).trim())?.messageId ??
    uniqueReplies[0]?.messageId ??
    group[0].messageId;

  if (!replyText.trim()) return [];
  return [
    {
      id: `${groupId}-final`,
      type: "text",
      text: replyText,
      content: replyText,
    },
  ];
}

function buildDeferredProcessTurnSdkMessage(group: TeamcluMessage[]): SdkMessage {
  const replies = group.filter((m) => m.kind === MessageKind.AGENT_REPLY);
  const uniqueReplies: TeamcluMessage[] = [];
  const replyIndexByKey = new Map<string, number>();
  for (const reply of replies) {
    const key = `${reply.content}\u0000${reply.model}`;
    const existingIndex = replyIndexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = uniqueReplies[existingIndex];
      if (!partsJson(existing) && partsJson(reply)) {
        uniqueReplies[existingIndex] = reply;
      }
      continue;
    }
    replyIndexByKey.set(key, uniqueReplies.length);
    uniqueReplies.push(reply);
  }

  const turnStatus = turnStatusFromReplies(uniqueReplies);
  const nativeSkillViolations = nativeSkillViolationsFromReplies(uniqueReplies);
  const finalParts = extractFinalTextPartsForDeferredTurn(group);
  const finalText = finalParts
    .map((p) => p.text || p.content || "")
    .filter(Boolean)
    .join("\n\n");
  const groupId =
    uniqueReplies.find((r) => displayContentForReply(r).trim())?.messageId ??
    uniqueReplies[0]?.messageId ??
    group[0].messageId;
  const modelID =
    uniqueReplies[uniqueReplies.length - 1]?.model ||
    group.find((m) => m.model)?.model ||
    undefined;
  const turnId = group[0]?.turnId?.trim() || undefined;
  const processMeta = countTurnProcessMeta(group);

  return {
    id: groupId,
    sessionId: group[0].sessionId,
    senderActorId: group[0].senderActorId,
    role: "assistant",
    content: finalText,
    modelID,
    parts: finalParts,
    toolCalls: [],
    replyToMessageId: firstNonEmptyReplyToMessageId(group),
    turnId,
    turnStatus,
    nativeSkillViolations,
    timestamp: new Date(Number(group[0].createdAt) * 1000),
    processDeferred: true,
    processMeta,
    lazyProcessRef: turnId
      ? {
          sessionId: group[0].sessionId,
          turnId,
          senderActorId: group[0].senderActorId,
        }
      : undefined,
  };
}

type BuildTurnSdkMessageOptions = {
  /** Omit process parts for completed historical turns (chat list). */
  deferProcess?: boolean;
  /** Always build full process (export). Overrides deferProcess. */
  forceFull?: boolean;
};

function buildTurnSdkMessage(
  group: TeamcluMessage[],
  opts?: BuildTurnSdkMessageOptions,
): SdkMessage {
  if (
    !opts?.forceFull &&
    opts?.deferProcess &&
    shouldDeferProcessParts(group)
  ) {
    return buildDeferredProcessTurnSdkMessage(group);
  }
  return buildFullTurnSdkMessageFromGroup(group);
}

function groupByTurn(
  msgs: TeamcluMessage[],
  opts?: BuildTurnSdkMessageOptions,
): SdkMessage[] {
  const out: SdkMessage[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    // Pass-through if no turnId (legacy / non-agent / user / system).
    if (!m.turnId || kindToRole(m.kind) !== "assistant") {
      out.push(adaptTeamcluMessageToSdk(m));
      i++;
      continue;
    }
    const turnId = m.turnId;
    const senderId = m.senderActorId;
    const group: TeamcluMessage[] = [];
    while (
      i < msgs.length &&
      msgs[i].turnId === turnId &&
      msgs[i].senderActorId === senderId
    ) {
      group.push(msgs[i]);
      i++;
    }
    out.push(buildTurnSdkMessage(group, opts));
  }
  return out;
}

export type AdaptTeamcluMessagesOptions = BuildTurnSdkMessageOptions;

export function adaptTeamcluMessages(
  msgs: TeamcluMessage[] | undefined,
  opts?: AdaptTeamcluMessagesOptions,
): SdkMessage[] | undefined {
  if (!msgs) return undefined;
  const sorted = [...msgs].sort(compareTeamcluMessages);
  return groupByTurn(sorted, opts);
}
