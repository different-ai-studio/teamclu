import { gunzipSync } from "fflate";

import type { SessionMessage } from "./session-types";

/**
 * A turn's recorded trace — iOS #1499 (`TurnTraceParser`). After a turn ends
 * the daemon uploads its thinking and tool calls as gzipped JSONL
 * (`apps/daemon/src/runtime/turn_trace.rs`); `GET /v1/sessions/{sid}/turns/{tid}/trace`
 * hands back a download URL. Without it the process page only showed what this
 * device happened to stream live — nothing at all for a turn from before the
 * session was opened.
 *
 * ```text
 * every line          turn_seq, type, ts_ms, [model]
 * thinking | reply    text, [text_original_size]
 * tool_call           tool_id, tool_name, status, [raw_input], [raw_output]
 * tool_result         tool_id, success, summary, [raw_output]
 * permission_request  request_id, tool_name, description
 * error               message, details
 * trace_truncated     dropped_events
 * ```
 */
export type TurnTraceLocation = { downloadUrl: string; size: number; sha256: string };

export type TurnTrace = { events: SessionMessage[]; droppedEvents: number };

type TraceContext = { turnId: string; agentId: string; sessionId: string; teamId: string };

function render(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return null;
}

export function parseTurnTrace(jsonl: string, ctx: TraceContext): TurnTrace {
  const events: SessionMessage[] = [];
  let droppedEvents = 0;
  const seenToolCalls = new Set<string>();

  const push = (line: Record<string, unknown>, kind: string, content: string, metadata: unknown = null) => {
    const turnSeq = typeof line.turn_seq === "number" ? line.turn_seq : events.length + 1;
    const tsMs = typeof line.ts_ms === "number" ? line.ts_ms : 0;
    events.push({
      messageId: `trace:${ctx.turnId}:${turnSeq}:${kind}`,
      kind,
      content,
      createdAt: new Date(tsMs).toISOString(),
      metadata,
      model: typeof line.model === "string" ? line.model : "",
      replyToMessageId: "",
      senderActorId: ctx.agentId,
      sessionId: ctx.sessionId,
      teamId: ctx.teamId,
      turnId: ctx.turnId,
    });
  };

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      line = parsed as Record<string, unknown>;
    } catch {
      continue; // A bad line is skipped, not the whole trace.
    }
    switch (line.type) {
      case "thinking":
      case "reply": {
        let text = typeof line.text === "string" ? line.text : "";
        if (!text) continue;
        const original = typeof line.text_original_size === "number" ? line.text_original_size : 0;
        if (original > new TextEncoder().encode(text).length) text += "\n…";
        push(line, line.type === "reply" ? "agent_reply" : "agent_thinking", text);
        break;
      }
      case "tool_call": {
        const toolId = typeof line.tool_id === "string" ? line.tool_id : "";
        if (!toolId || seenToolCalls.has(toolId)) continue;
        seenToolCalls.add(toolId);
        const input = line.raw_input;
        push(line, "agent_tool_call", render(input) ?? "", {
          tool_id: toolId,
          tool_name: typeof line.tool_name === "string" ? line.tool_name : "",
          params: input && typeof input === "object" ? input : undefined,
        });
        // A failed call can close without a separate result line.
        if (line.status === "failed") {
          push(line, "agent_tool_result", render(line.raw_output) ?? "", { tool_id: toolId, success: false });
        }
        break;
      }
      case "tool_result": {
        const toolId = typeof line.tool_id === "string" ? line.tool_id : "";
        if (!toolId) continue;
        if (!seenToolCalls.has(toolId)) {
          // The call fell past the size budget; the result is still worth a row.
          seenToolCalls.add(toolId);
          push(line, "agent_tool_call", "", { tool_id: toolId, tool_name: "" });
        }
        push(line, "agent_tool_result", render(line.summary) ?? render(line.raw_output) ?? "", {
          tool_id: toolId,
          success: line.success !== false,
        });
        break;
      }
      case "permission_request":
        push(line, "permission_request", render(line.description) ?? "", {
          request_id: line.request_id,
          tool_name: line.tool_name,
        });
        break;
      case "error": {
        const message = render(line.message) ?? render(line.details);
        if (message) push(line, "agent_error", message);
        break;
      }
      case "trace_truncated":
        droppedEvents += typeof line.dropped_events === "number" ? line.dropped_events : 0;
        break;
      default:
        break; // status_change and anything newer: nothing to draw.
    }
  }
  return { events, droppedEvents };
}

/** gunzip → UTF-8 text. Hermes has no DecompressionStream, hence fflate. */
export function gunzipText(bytes: Uint8Array): string {
  return new TextDecoder().decode(gunzipSync(bytes));
}

export async function loadTurnTrace(args: {
  locate: () => Promise<TurnTraceLocation | null>;
  fetchImpl?: typeof fetch;
  ctx: TraceContext;
}): Promise<TurnTrace | null> {
  const location = await args.locate();
  if (!location) return null;
  const response = await (args.fetchImpl ?? fetch)(location.downloadUrl);
  if (!response.ok) throw new Error(`trace download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Some stores hand back an already-inflated body; gzip starts 1f 8b.
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipText(bytes) : new TextDecoder().decode(bytes);
  return parseTurnTrace(text, args.ctx);
}
