import type { ToolCall } from "@/stores/session-types";

/** Filter console with `[stream-tool-diag]` when reproducing parallel pwd / Failed UI. */
export function logStreamToolDiag(
  stage: string,
  payload: Record<string, unknown> = {},
): void {
  console.info(`[stream-tool-diag] ${stage}`, {
    at: new Date().toISOString(),
    ...payload,
  });
}

export function summarizeToolCallsForDiag(
  toolCalls: ToolCall[] | undefined,
): Array<{ id: string; status: string }> {
  return (toolCalls ?? []).map((tc) => ({
    id: tc.id.length > 12 ? `…${tc.id.slice(-12)}` : tc.id,
    status: tc.status,
  }));
}
