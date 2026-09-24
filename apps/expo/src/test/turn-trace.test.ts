import { gzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { foldToolResults } from "../features/sessions/tool-display";
import { loadTurnTrace, parseTurnTrace } from "../features/sessions/turn-trace";

const ctx = { turnId: "turn-1", agentId: "agent-1", sessionId: "s1", teamId: "t1" };
const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("parseTurnTrace", () => {
  it("projects thinking, replies, tools and errors into turn events", () => {
    const { events, droppedEvents } = parseTurnTrace(
      jsonl([
        { turn_seq: 1, type: "thinking", ts_ms: 1000, text: "hmm", model: "m1" },
        { turn_seq: 2, type: "tool_call", ts_ms: 1100, tool_id: "t1", tool_name: "bash", status: "pending", raw_input: { cmd: "ls" } },
        { turn_seq: 3, type: "tool_call", ts_ms: 1150, tool_id: "t1", tool_name: "bash", status: "completed" },
        { turn_seq: 4, type: "tool_result", ts_ms: 1200, tool_id: "t1", success: true, summary: "3 files" },
        { turn_seq: 5, type: "status_change", ts_ms: 1250 },
        { turn_seq: 6, type: "error", ts_ms: 1300, message: "boom" },
        { turn_seq: 7, type: "reply", ts_ms: 1400, text: "done" },
        { type: "trace_truncated", dropped_events: 12 },
      ]),
      ctx,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "agent_thinking",
      "agent_tool_call",
      "agent_tool_result",
      "agent_error",
      "agent_reply",
    ]);
    expect(events[0]).toMatchObject({ content: "hmm", model: "m1", senderActorId: "agent-1", turnId: "turn-1" });
    expect(events[0].createdAt).toBe(new Date(1000).toISOString());
    expect(events[1].metadata).toMatchObject({ tool_id: "t1", tool_name: "bash", params: { cmd: "ls" } });
    expect(droppedEvents).toBe(12);

    // The result folds into its call exactly as live events do.
    const { resultByToolId } = foldToolResults(events);
    expect(resultByToolId.get("t1")).toEqual({ summary: "3 files", success: true });
  });

  it("keeps a result whose call fell past the budget, and marks a failed call", () => {
    const { events } = parseTurnTrace(
      jsonl([
        { turn_seq: 1, type: "tool_result", tool_id: "orphan", success: false, raw_output: "nope" },
        { turn_seq: 2, type: "tool_call", tool_id: "f", tool_name: "edit", status: "failed", raw_output: "denied" },
      ]),
      ctx,
    );
    const { resultByToolId } = foldToolResults(events);
    expect(resultByToolId.get("orphan")).toEqual({ summary: "nope", success: false });
    expect(resultByToolId.get("f")).toEqual({ summary: "denied", success: false });
  });

  it("marks truncated text and skips lines that don't parse", () => {
    const { events } = parseTurnTrace(
      `not json\n${JSON.stringify({ turn_seq: 1, type: "reply", text: "head", text_original_size: 99 })}\n`,
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("head\n…");
  });
});

describe("loadTurnTrace", () => {
  it("downloads and gunzips the trace", async () => {
    const body = gzipSync(new TextEncoder().encode(jsonl([{ turn_seq: 1, type: "reply", text: "hi" }])));
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const trace = await loadTurnTrace({
      locate: async () => ({ downloadUrl: "https://oss.test/t.gz", size: body.length, sha256: "" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ctx,
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://oss.test/t.gz");
    expect(trace?.events.map((e) => e.content)).toEqual(["hi"]);
  });

  it("is null when no trace was uploaded", async () => {
    expect(await loadTurnTrace({ locate: async () => null, ctx })).toBeNull();
  });
});
