import {
  isTodoTool,
  paramsFromToolArguments,
} from "@/components/chat/tool-calls/tool-call-utils";
import { agentStreamKey } from "@/lib/stream/live-agent-stream";
import type { StreamingPlanEntry } from "@/stores/v2-streaming-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

type RawTodoItem = {
  content?: string;
  status?: string;
  priority?: string;
};

function parseJsonArray(value: string): RawTodoItem[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as RawTodoItem[]) : null;
  } catch {
    return null;
  }
}

function extractTodosFromDescription(description: string): RawTodoItem[] | null {
  const trimmed = description.trim();
  if (!trimmed) return null;
  const direct = parseJsonArray(trimmed);
  if (direct) return direct;
  try {
    const obj = JSON.parse(trimmed) as { todos?: unknown };
    if (Array.isArray(obj.todos)) return obj.todos as RawTodoItem[];
  } catch {
    // not JSON
  }
  return null;
}

export function mapRawTodosToPlanEntries(items: RawTodoItem[]): StreamingPlanEntry[] {
  return items
    .map((item) => ({
      content: (item.content ?? "").trim(),
      priority: (item.priority === "high" || item.priority === "medium" || item.priority === "low"
        ? item.priority
        : "medium") as StreamingPlanEntry["priority"],
      status: (item.status === "in_progress"
        ? "in_progress"
        : item.status === "completed"
          ? "completed"
          : "pending") as StreamingPlanEntry["status"],
    }))
    .filter((entry) => entry.content.length > 0);
}

export function mapAcpPlanEntries(
  entries: Array<{ content?: string; priority?: string; status?: string }>,
): StreamingPlanEntry[] {
  return mapRawTodosToPlanEntries(entries);
}

export function isTodoToolInvocation(
  toolName: string,
  params: Record<string, string>,
): boolean {
  if (isTodoTool(toolName)) return true;
  const hint = (params.description ?? "").trim().toLowerCase();
  if (hint === "todowrite" || hint === "todoread" || hint === "todo_write" || hint === "todo_read") {
    return true;
  }
  return Boolean(params.todos?.trim());
}

function parseTodoItemsFromSources(args: {
  params: Record<string, string>;
  description?: string;
  summary?: string;
}): RawTodoItem[] | null {
  const fromParams = args.params.todos ? parseJsonArray(args.params.todos) : null;
  if (fromParams?.length) return fromParams;

  const fromSummary = args.summary ? parseJsonArray(args.summary) : null;
  if (fromSummary?.length) return fromSummary;

  if (args.description) {
    const fromDescription = extractTodosFromDescription(args.description);
    if (fromDescription?.length) return fromDescription;
  }

  return null;
}

/** Bridge OpenCode `todowrite` tool payloads into the inline Todo dock (`setPlan`). */
export function syncPlanFromTodoTool(
  sessionId: string,
  actorId: string,
  args: {
    toolName: string;
    params: Record<string, string>;
    description?: string;
    summary?: string;
    success?: boolean;
  },
): boolean {
  if (args.success === false) return false;
  if (!isTodoToolInvocation(args.toolName, args.params)) return false;

  const raw = parseTodoItemsFromSources(args);
  if (!raw?.length) return false;

  const entries = mapRawTodosToPlanEntries(raw);
  if (!entries.length) return false;

  useV2StreamingStore.getState().setPlan(sessionId, actorId, entries);
  return true;
}

/** After `completeToolUse`, resolve the tool row and bridge its todo payload. */
export function syncPlanFromTodoToolResult(
  sessionId: string,
  actorId: string,
  args: { toolId: string; success: boolean; summary: string },
): boolean {
  const toolCall = useV2StreamingStore
    .getState()
    .byKey[agentStreamKey(sessionId, actorId)]?.toolCalls.find((tc) => tc.id === args.toolId);

  return syncPlanFromTodoTool(sessionId, actorId, {
    toolName: toolCall?.name ?? "",
    params: paramsFromToolArguments(
      toolCall?.arguments as Record<string, unknown> | undefined,
    ),
    description:
      typeof toolCall?.arguments?.description === "string"
        ? toolCall.arguments.description
        : undefined,
    summary: args.summary,
    success: args.success,
  });
}
