/**
 * Temporary diagnostics for extension Process / Reply-to / duplicate-header bugs.
 * DevTools filter: `ext-msg-diag`
 * Dump: `window.teamcluExtMsgDiagDump()`
 *
 * Always logs (not gated on import.meta.env.DEV) so packaged extension builds
 * still surface evidence in the side panel inspector.
 */

import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import { MessageKind } from "@/lib/proto/teamclu_pb";

const LOG_PREFIX = "[ext-msg-diag]";
const RING_MAX = 120;

type DiagRecord = {
  at: string;
  stage: string;
  [key: string]: unknown;
};

const ring: DiagRecord[] = [];

function push(record: DiagRecord): void {
  ring.push(record);
  if (ring.length > RING_MAX) ring.shift();
}

function partsMeta(partsJson: string | null | undefined): {
  partsLen: number;
  partTypes: string[];
} {
  if (!partsJson?.trim()) return { partsLen: 0, partTypes: [] };
  try {
    const parts = JSON.parse(partsJson) as Array<{ type?: string }>;
    if (!Array.isArray(parts)) return { partsLen: 0, partTypes: ["not-array"] };
    return {
      partsLen: parts.length,
      partTypes: parts.map((p) => p.type ?? "?"),
    };
  } catch {
    return { partsLen: -1, partTypes: ["parse-error"] };
  }
}

/** Compact one-line summary of a proto message for Process / duplicate checks. */
export function summarizeProtoForExtDiag(m: TeamcluMessage): Record<string, unknown> {
  const partsJson = (m as { partsJson?: string | null }).partsJson ?? null;
  const id = m.messageId ?? "";
  return {
    id,
    kind: MessageKind[m.kind] ?? m.kind,
    turnId: m.turnId || "",
    replyTo: m.replyToMessageId?.trim() || "",
    contentLen: (m.content ?? "").trim().length,
    isInterrupt: id.startsWith("interrupt-"),
    ...partsMeta(partsJson),
  };
}

export function summarizeProtosForExtDiag(
  messages: TeamcluMessage[],
): Record<string, unknown> {
  const assistant = messages.filter(
    (m) =>
      m.kind === MessageKind.AGENT_REPLY ||
      m.kind === MessageKind.AGENT_THINKING ||
      m.kind === MessageKind.AGENT_TOOL_CALL ||
      m.kind === MessageKind.AGENT_TOOL_RESULT,
  );
  const interrupts = assistant.filter((m) => m.messageId.startsWith("interrupt-"));
  const replies = assistant.filter((m) => m.kind === MessageKind.AGENT_REPLY);
  const replyTos = replies.filter((m) => Boolean(m.replyToMessageId?.trim()));
  const withParts = replies.filter((m) => {
    const p = (m as { partsJson?: string | null }).partsJson;
    return Boolean(p?.trim());
  });

  return {
    total: messages.length,
    assistantCount: assistant.length,
    agentReplyCount: replies.length,
    interruptCount: interrupts.length,
    replyToCount: replyTos.length,
    agentReplyWithParts: withParts.length,
    /** Tail — what you usually see at the bottom of the thread */
    tail: messages.slice(-8).map(summarizeProtoForExtDiag),
    interrupts: interrupts.map(summarizeProtoForExtDiag),
    agentReplies: replies.slice(-6).map(summarizeProtoForExtDiag),
  };
}

/** Always-on console + ring buffer. Filter DevTools by `ext-msg-diag`. */
export function logExtMsgDiag(
  stage: string,
  payload: Record<string, unknown> = {},
): void {
  const record: DiagRecord = {
    at: new Date().toISOString(),
    stage,
    ...payload,
  };
  push(record);
  console.info(`${LOG_PREFIX} ${stage}`, record);
}

function dumpExtMsgDiag(): DiagRecord[] {
  console.table(ring);
  return [...ring];
}

declare global {
  interface Window {
    teamcluExtMsgDiagDump?: () => DiagRecord[];
  }
}

if (typeof window !== "undefined") {
  window.teamcluExtMsgDiagDump = dumpExtMsgDiag;
}
