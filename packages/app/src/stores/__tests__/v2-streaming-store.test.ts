import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isErrorOnlyStreamEntry,
  isStreamInterruptible,
  useV2StreamingStore,
  selectStreamsForSession,
  flushPendingSessionRevisionsForTests,
} from "../v2-streaming-store";

beforeEach(() => {
  flushPendingSessionRevisionsForTests();
  // Reset to a clean state
  useV2StreamingStore.setState({
    byKey: {},
    archived: [],
    persistedPlansBySession: {},
    interruptedFlushPending: {},
    revisionBySession: {},
    compactionPartsByMessageId: {},
  });
});

describe("v2-streaming-store", () => {
  it("appendOutput accumulates deltas for the same actor", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "Hello ");
    useV2StreamingStore.getState().appendOutput("s1", "a1", "world");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams).toHaveLength(1);
    expect(streams[0].outputText).toBe("Hello world");
    expect(streams[0].parts.map((p) => p.type)).toEqual(["text"]);
    expect(streams[0].parts[0].text).toBe("Hello world");
  });

  it("appendThinking is separate from output", () => {
    useV2StreamingStore.getState().appendThinking("s1", "a1", "let me think");
    useV2StreamingStore.getState().appendOutput("s1", "a1", "answer");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams[0].thinkingText).toBe("let me think");
    expect(streams[0].outputText).toBe("answer");
  });

  it("appendThinking merges overlapping reasoning chunks on the resume path", () => {
    // Overlap-strip dedup is resume/replay-only (mergeOverlap=true); live
    // deltas are eventId-deduped upstream and use plain concat.
    const store = useV2StreamingStore.getState();
    store.appendThinking("s1", "a1", "This", true);
    store.appendThinking("s1", "a1", "This is", true);
    store.appendThinking("s1", "a1", " is the", true);
    store.appendThinking("s1", "a1", " the 8th", true);
    store.appendThinking("s1", "a1", "8th time", true);

    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams[0].thinkingText).toBe("This is the 8th time");
  });

  it("appendOutput merges cumulative snapshot chunks on the resume path", () => {
    const store = useV2StreamingStore.getState();
    for (const chunk of [
      "/Users",
      "/Users/haigang",
      "/Users/haigang.ye/project/external/teamclu-next",
    ]) {
      store.appendOutput("s1", "a1", chunk, true);
    }
    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("/Users/haigang.ye/project/external/teamclu-next");
    expect(stream.parts[0].text).toBe("/Users/haigang.ye/project/external/teamclu-next");
  });

  it("appendOutput tolerates duplicate resume delivery of the same chunks", () => {
    const store = useV2StreamingStore.getState();
    for (const chunk of ["/Users", "/ha", "igang", ".ye"]) {
      store.appendOutput("s1", "a1", chunk, true);
      store.appendOutput("s1", "a1", chunk, true);
    }
    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("/Users/haigang.ye");
    expect(stream.parts[0].text).toBe("/Users/haigang.ye");
  });

  it("appendOutput preserves genuinely repeated live deltas (plain concat)", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "test ");
    store.appendOutput("s1", "a1", "test ");
    store.appendThinking("s1", "a1", "\n\n");
    store.appendThinking("s1", "a1", "\n\n");
    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("test test ");
    expect(stream.thinkingText).toBe("\n\n\n\n");
  });

  it("keeps thinking segments in ACP event order", () => {
    const store = useV2StreamingStore.getState();
    store.appendThinking("s1", "a1", "Plan first.");
    store.appendOutput("s1", "a1", "Before tool.");
    store.appendThinking("s1", "a1", "Plan second.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "pwd",
      params: { command: "pwd" },
      toolKind: "execute",
    });
    store.appendThinking("s1", "a1", "Plan third.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.thinkingText).toBe("Plan first.Plan second.Plan third.");
    expect(stream.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "reasoning",
      "tool-call",
      "reasoning",
    ]);
    expect(stream.parts[0].text).toBe("Plan first.");
    expect(stream.parts[2].text).toBe("Plan second.");
    expect(stream.parts[4].text).toBe("Plan third.");
  });

  it("clearActor removes only that actor", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s1", "a2", "y");
    useV2StreamingStore.getState().clearActor("s1", "a1");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams).toHaveLength(1);
    expect(streams[0].actorId).toBe("a2");
  });

  it("clearSession removes all entries for that session only", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s2", "a1", "y");
    useV2StreamingStore.getState().clearSession("s1");
    const all = useV2StreamingStore.getState().byKey;
    expect(Object.keys(all)).toHaveLength(1);
    expect(all["s2::a1"]).toBeDefined();
  });

  it("selectStreamsForSession ignores other sessions", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s2", "a1", "y");
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")).toHaveLength(1);
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s2")).toHaveLength(1);
  });

  it("archives the prior turn when a new turn starts after finalize", () => {
    const store = useV2StreamingStore.getState();
    // Turn 1: tool + finalize
    store.pushToolUse("s1", "a1", {
      toolId: "t1", toolName: "Bash", description: "ls", params: {}, toolKind: "execute",
    });
    store.finalize("s1", "a1", "turn 1 reply");

    // Turn 2: any new event triggers archival of turn 1
    useV2StreamingStore.getState().appendOutput("s1", "a1", "turn 2 starting");

    const all = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(all).toHaveLength(2);
    // Archived turn 1 keeps its tool call
    const turn1 = all.find((e) => e.toolCalls.length > 0);
    expect(turn1).toBeDefined();
    expect(turn1!.outputText).toBe("turn 1 reply");
    expect(turn1!.active).toBe(false);
    // Current turn 2 has the new output
    const turn2 = all.find((e) => e.outputText === "turn 2 starting");
    expect(turn2).toBeDefined();
    expect(turn2!.active).toBe(true);
  });

  it("keeps live output and tool calls in event order", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "grep",
      description: "search",
      params: {},
      toolKind: "search",
    });
    store.appendOutput("s1", "a1", "After tool.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(stream.parts[0].text).toBe("Before tool.");
    expect(stream.parts[1].toolCall?.id).toBe("tool-1");
    expect(stream.parts[2].text).toBe("After tool.");
  });

  it("preserves spaces in tokenized post-tool acp.output deltas", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "The `issue-normalizer` skill is not available.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "skill",
      description: "skill",
      params: { name: "issue-normalizer" },
    });
    for (const delta of [
      "The",
      " J",
      "IRA",
      " page",
      " requires",
      " login",
    ]) {
      store.appendOutput("s1", "a1", delta);
    }

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toContain("The JIRA page requires login");
    expect(stream.parts[2].text).toBe("The JIRA page requires login");
  });

  it("merges later toolUse updates into the existing tool call", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "Execute ps command",
      params: {},
      toolKind: "execute",
    });
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.toolCalls).toHaveLength(1);
    expect(stream.parts).toHaveLength(1);
    expect(stream.toolCalls[0].arguments).toMatchObject({
      _description: "Execute ps command",
      command: "ps aux",
    });
    expect(stream.parts[0].toolCall?.arguments).toMatchObject({
      _description: "Execute ps command",
      command: "ps aux",
    });
  });

  it("uses parked agent replies as a live preview without duplicating existing output", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.ingestReplyPreview("s1", "a1", "Before tool.Final answer.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("Before tool.Final answer.");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(stream.parts[0].text).toBe("Before tool.");
    expect(stream.parts[2].text).toBe("Final answer.");

    store.ingestReplyPreview("s1", "a1", "Before tool.Final answer.");
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")[0].parts).toHaveLength(3);
  });

  it("appends distinct reply preview segments after tool calls", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.ingestReplyPreview("s1", "a1", "CPU Top 3:\n1. foo");
    store.ingestReplyPreview("s1", "a1", "Memory Top 3:\n1. bar");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toContain("CPU Top 3");
    expect(stream.outputText).toContain("Memory Top 3");
    expect(stream.parts.map((p) => p.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "text",
    ]);
    expect(stream.parts[2].text).toContain("CPU Top 3");
    expect(stream.parts[3].text).toContain("Memory Top 3");
  });

  it("finalize does not rewrite multi-segment transcript from cumulative daemon text", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });
    store.ingestReplyPreview("s1", "a1", "CPU Top 3:\n1. foo");
    store.ingestReplyPreview("s1", "a1", "Memory Top 3:\n1. bar");

    store.finalize("s1", "a1", "Before tool.\n\nCPU Top 3:\n1. foo\n\nMemory Top 3:\n1. bar");

    const [finalized] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(finalized.active).toBe(false);
    expect(finalized.parts.map((p) => p.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "text",
    ]);
    expect(finalized.parts[0].text).toBe("Before tool.");
    expect(finalized.parts[2].text).toContain("CPU Top 3");
    expect(finalized.parts[3].text).toContain("Memory Top 3");
  });

  it("releaseActorAfterPersist skipArchive only drops archived rows for the current streamId", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });
    const firstStreamId = useV2StreamingStore.getState().byKey["s1::a1"].streamId;
    store.releaseActorAfterPersist("s1", "a1");
    expect(useV2StreamingStore.getState().archived).toHaveLength(1);
    expect(useV2StreamingStore.getState().archived[0].streamId).toBe(firstStreamId);

    store.pushToolUse("s1", "a1", {
      toolId: "tool-2",
      toolName: "bash",
      description: "df",
      params: { command: "df -h" },
      toolKind: "execute",
    });
    const secondStreamId = useV2StreamingStore.getState().byKey["s1::a1"].streamId;
    expect(secondStreamId).not.toBe(firstStreamId);

    store.releaseActorAfterPersist("s1", "a1", {
      persistedPartsJson: JSON.stringify([
        { id: "t2", type: "tool-call", toolCallId: "tool-2", toolCall: { id: "tool-2" } },
      ]),
    });

    expect(useV2StreamingStore.getState().archived).toHaveLength(1);
    expect(useV2StreamingStore.getState().archived[0].streamId).toBe(firstStreamId);
  });

  it("detachLiveStreamForPersist drops byKey without archiving", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "sleep 30",
      params: { command: "sleep 30" },
      toolKind: "execute",
    });
    const streamId = useV2StreamingStore.getState().byKey["s1::a1"].streamId;
    store.finishSessionActor("s1", "a1");
    store.detachLiveStreamForPersist("s1", "a1", streamId);

    const state = useV2StreamingStore.getState();
    expect(state.byKey["s1::a1"]).toBeUndefined();
    expect(state.archived).toHaveLength(0);
    store.beginPlanningPlaceholder("s1", "a1");
    expect(useV2StreamingStore.getState().archived).toHaveLength(0);
  });

  it("releaseActorAfterPersist clears archived interrupted turn via persistedSourceStreamId", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "sleep 30",
      params: { command: "sleep 30" },
      toolKind: "execute",
    });
    const interruptedStreamId =
      useV2StreamingStore.getState().byKey["s1::a1"].streamId;
    store.finishSessionActor("s1", "a1", { reason: "interrupt" });
    store.beginPlanningPlaceholder("s1", "a1");
    expect(useV2StreamingStore.getState().archived).toHaveLength(1);
    expect(useV2StreamingStore.getState().archived[0].streamId).toBe(
      interruptedStreamId,
    );

    store.releaseActorAfterPersist("s1", "a1", {
      persistedPartsJson: JSON.stringify([
        {
          id: "t1",
          type: "tool-call",
          toolCallId: "tool-1",
          toolCall: { id: "tool-1" },
        },
      ]),
      persistedSourceStreamId: interruptedStreamId,
    });

    expect(useV2StreamingStore.getState().archived).toHaveLength(0);
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")).toHaveLength(
      0,
    );
  });

  it("releaseActorAfterPersist skips archive when parts_json already has tools", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.releaseActorAfterPersist("s1", "a1", {
      persistedPartsJson: JSON.stringify([
        { id: "t1", type: "tool-call", toolCallId: "tool-1", toolCall: { id: "tool-1" } },
      ]),
    });

    const state = useV2StreamingStore.getState();
    expect(state.byKey["s1::a1"]).toBeUndefined();
    expect(state.archived).toHaveLength(0);
    expect(selectStreamsForSession(state, "s1")).toHaveLength(0);
  });

  it("releaseActorAfterPersist archives tool calls when parts_json did not persist them", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });
    store.appendOutput("s1", "a1", "Done.");

    store.releaseActorAfterPersist("s1", "a1");

    const state = useV2StreamingStore.getState();
    expect(state.byKey["s1::a1"]).toBeUndefined();
    expect(state.archived).toHaveLength(1);
    expect(state.archived[0].toolCalls).toHaveLength(1);
    expect(state.archived[0].parts.some((part) => part.type === "tool-call")).toBe(true);
    expect(selectStreamsForSession(state, "s1")).toHaveLength(1);
  });

  it("places reply previews after the latest tool when final text is not cumulative", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.ingestReplyPreview("s1", "a1", "Final answer only.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("Final answer only.");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(stream.parts[0].text).toBe("Before tool.");
    expect(stream.parts[2].text).toBe("Final answer only.");

    store.ingestReplyPreview("s1", "a1", "Final answer only.");
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")[0].parts).toHaveLength(3);

    store.finalize("s1", "a1", "Updated final answer.");
    const [finalized] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(finalized.active).toBe(false);
    expect(finalized.parts).toHaveLength(3);
    expect(finalized.parts[2].text).toBe("Updated final answer.");
  });

  it("beginPlanningPlaceholder opens an empty active stream for statusChange ACTIVE", () => {
    const store = useV2StreamingStore.getState();
    store.beginPlanningPlaceholder("s1", "a1");

    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry.active).toBe(true);
    expect(entry.outputText).toBe("");
    expect(entry.thinkingText).toBe("");
    expect(entry.parts).toHaveLength(0);
  });

  it("beginPlanningPlaceholder does not clobber an in-flight stream with content", () => {
    const store = useV2StreamingStore.getState();
    store.appendThinking("s1", "a1", "Already thinking");
    store.beginPlanningPlaceholder("s1", "a1");

    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry.thinkingText).toBe("Already thinking");
  });

  it("markActorStreamActive re-opens a stream after finishSessionActor", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Hello");
    store.finishSessionActor("s1", "a1");

    expect(useV2StreamingStore.getState().byKey["s1::a1"].active).toBe(false);

    store.markActorStreamActive("s1", "a1");
    store.appendOutput("s1", "a1", " world");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.active).toBe(true);
    expect(stream.outputText).toBe("Hello world");
  });

  it("finishSessionActor stops unresolved tool calls from loading", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "grep",
      description: "search",
      params: {},
      toolKind: "search",
    });

    store.finishSessionActor("s1", "a1");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.active).toBe(false);
    expect(stream.toolCalls[0].status).toBe("failed");
    expect(stream.toolCalls[0].result).toBe("Stream ended before this tool returned a result.");
    expect(stream.parts[0].toolCall?.status).toBe("failed");
  });

  it("treats errored streams as visible but not interruptible", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Partial output");
    store.setError("s1", "a1", "No output", "Model misconfigured");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.active).toBe(true);
    expect(stream.errorMessage).toBe("No output");
    expect(isStreamInterruptible(stream)).toBe(false);
  });

  it("clearStaleStreamErrors removes error-only live and archived streams", () => {
    const store = useV2StreamingStore.getState();
    store.setError("s1", "a1", "ACP prompt failed", "Authentication required");
    store.finishSessionActor("s1", "a1");
    store.beginPlanningPlaceholder("s1", "a1");
    store.appendOutput("s1", "a1", "Retry succeeded");

    expect(
      selectStreamsForSession(useV2StreamingStore.getState(), "s1").some(
        (entry) => entry.errorMessage,
      ),
    ).toBe(false);
  });

  it("clearStaleStreamErrors drops inactive error-only live streams", () => {
    const store = useV2StreamingStore.getState();
    store.setError("s1", "a1", "ACP prompt failed", "Authentication required");
    store.finishSessionActor("s1", "a1");
    expect(isErrorOnlyStreamEntry(useV2StreamingStore.getState().byKey["s1::a1"]!)).toBe(
      true,
    );

    store.clearStaleStreamErrors("s1", "a1");
    expect(useV2StreamingStore.getState().byKey["s1::a1"]).toBeUndefined();
    expect(useV2StreamingStore.getState().archived).toHaveLength(0);
  });

  it("clearStaleStreamErrors strips error banners but keeps partial transcript", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Partial output");
    store.setError("s1", "a1", "No output", "Model misconfigured");

    store.clearStaleStreamErrors("s1", "a1");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.errorMessage).toBeNull();
    expect(stream.outputText).toBe("Partial output");
  });

  it("beginPlanningPlaceholder does not archive error-only turns", () => {
    const store = useV2StreamingStore.getState();
    store.setError("s1", "a1", "ACP prompt failed", "Authentication required");
    store.finishSessionActor("s1", "a1");

    store.beginPlanningPlaceholder("s1", "a1");

    const state = useV2StreamingStore.getState();
    expect(state.archived).toHaveLength(0);
    expect(state.byKey["s1::a1"]?.errorMessage).toBeNull();
    expect(state.byKey["s1::a1"]?.active).toBe(true);
  });

  it("drops orphan tool results when no live or archived stream exists", () => {
    const store = useV2StreamingStore.getState();

    store.completeToolUse("s1", "a1", {
      toolId: "tool-1",
      success: true,
      summary: "done",
    });

    expect(useV2StreamingStore.getState().byKey["s1::a1"]).toBeUndefined();
    expect(useV2StreamingStore.getState().archived).toHaveLength(0);
  });

  it("adds a completed placeholder onto an existing live stream when tool use was missed", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "working");

    store.completeToolUse("s1", "a1", {
      toolId: "tool-1",
      success: true,
      summary: "done",
    });

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.toolCalls).toHaveLength(1);
    expect(stream.toolCalls[0]).toMatchObject({
      id: "tool-1",
      name: "unknown",
      status: "completed",
      result: "done",
    });
    expect(stream.parts.some((p) => p.toolCall?.id === "tool-1")).toBe(true);
  });

  it("routes late tool results to archived streams instead of creating a phantom bubble", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "sleep-tool",
      toolName: "bash",
      description: "Sleep for 30 seconds",
      params: { command: "sleep 30" },
      toolKind: "execute",
    });
    store.finishSessionActor("s1", "a1");
    store.beginPlanningPlaceholder("s1", "a1");

    store.completeToolUse("s1", "a1", {
      toolId: "sleep-tool",
      success: true,
      summary: "slept",
    });

    const state = useV2StreamingStore.getState();
    expect(state.byKey["s1::a1"].toolCalls).toHaveLength(0);
    expect(state.archived).toHaveLength(1);
    expect(state.archived[0].toolCalls[0]).toMatchObject({
      id: "sleep-tool",
      status: "completed",
      result: "slept",
    });
    const streams = selectStreamsForSession(state, "s1");
    expect(streams.filter((entry) => entry.toolCalls.length > 0)).toHaveLength(1);
    expect(streams.find((entry) => entry.toolCalls[0]?.id === "sleep-tool")?.toolCalls[0]?.status).toBe(
      "completed",
    );
  });

  it("does not reopen an active live stream for orphan tool results after release", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "sleep-tool",
      toolName: "bash",
      description: "sleep",
      params: {},
      toolKind: "execute",
    });
    store.releaseActorAfterPersist("s1", "a1", {
      persistedPartsJson: JSON.stringify([
        {
          type: "tool-call",
          toolCallId: "sleep-tool",
          toolCall: { id: "sleep-tool", status: "failed", name: "bash" },
        },
      ]),
    });

    store.completeToolUse("s1", "a1", {
      toolId: "sleep-tool",
      success: true,
      summary: "User aborted the command",
    });

    expect(useV2StreamingStore.getState().byKey["s1::a1"]).toBeUndefined();
  });

  it("replaceParts does not downgrade completed tools to calling (enrich race)", () => {
    const store = useV2StreamingStore.getState();
    const ids = ["tool-1", "tool-2", "tool-3"];
    for (const toolId of ids) {
      store.pushToolUse("s1", "a1", {
        toolId,
        toolName: "bash",
        description: "pwd",
        params: { command: "pwd" },
        toolKind: "execute",
      });
      store.completeToolUse("s1", "a1", {
        toolId,
        success: true,
        summary: "/workspace",
      });
    }

    store.replaceParts(
      "s1",
      "a1",
      ids.map((toolId) => ({
        id: `stream:tool:${toolId}`,
        type: "tool-call" as const,
        toolCallId: toolId,
        toolCall: {
          id: toolId,
          name: "bash",
          toolKind: "execute",
          status: "calling" as const,
          arguments: { command: "pwd" },
          startTime: new Date(0),
        },
      })),
    );

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.toolCalls.map((tc) => tc.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(stream.parts.every((p) => p.toolCall?.status === "completed")).toBe(true);
  });

  it("replaceParts updates the live tool result without waiting for session reload", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "Print working directory",
      params: { command: "pwd" },
      toolKind: "execute",
    });
    store.completeToolUse("s1", "a1", {
      toolId: "tool-1",
      success: true,
      summary: "Print working directory",
    });

    store.replaceParts("s1", "a1", [
      {
        id: "stream:tool:tool-1",
        type: "tool-call",
        toolCallId: "tool-1",
        toolCall: {
          id: "tool-1",
          name: "bash",
          toolKind: "execute",
          status: "completed",
          arguments: { command: "pwd", description: "Print working directory" },
          result: "/Users/haigang.ye/project/external/teamclu-next\n",
          startTime: "2026-05-25T00:00:00.000Z" as unknown as Date,
        },
      },
    ]);

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.toolCalls[0].result).toContain("teamclu-next");
    expect(stream.parts[0].toolCall?.result).toContain("teamclu-next");
    expect(stream.parts[0].toolCall?.startTime).toBeInstanceOf(Date);
  });

  it("keeps persisted session plan after clearActor removes the live stream", () => {
    const store = useV2StreamingStore.getState();
    store.setPlan("s1", "a1", [
      { content: "Task one", priority: "high", status: "in_progress" },
      { content: "Task two", priority: "medium", status: "pending" },
    ]);
    store.clearActor("s1", "a1");

    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")).toHaveLength(0);
    expect(useV2StreamingStore.getState().persistedPlansBySession.s1?.planEntries).toHaveLength(2);
  });

  it("keeps the latest non-empty plan when an empty update arrives", () => {
    const store = useV2StreamingStore.getState();
    store.setPlan("s1", "a1", [
      { content: "Analyze requirements", priority: "high", status: "in_progress" },
      { content: "Write tests", priority: "medium", status: "pending" },
    ]);

    store.setPlan("s1", "a1", []);

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.planEntries).toHaveLength(2);
    expect(stream.planEntries[0].content).toBe("Analyze requirements");
    expect(stream.planEntries[1].content).toBe("Write tests");
  });

  it("tracks interrupted flush pending per actor and clears on beginPlanning", () => {
    const store = useV2StreamingStore.getState();
    store.markInterruptedFlushPending("s1", "a1");
    expect(store.isInterruptedFlushPending("s1", "a1")).toBe(true);
    expect(store.isInterruptedFlushPending("s1", "a2")).toBe(false);

    store.clearInterruptedFlushPending("s1", "a1");
    expect(store.isInterruptedFlushPending("s1", "a1")).toBe(false);

    store.markInterruptedFlushPending("s1", "a1");
    store.beginPlanningPlaceholder("s1", "a1");
    expect(store.isInterruptedFlushPending("s1", "a1")).toBe(false);
  });

  it("adds a completed placeholder when a result references an unseen tool in an existing stream", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before.");

    store.completeToolUse("s1", "a1", {
      toolId: "tool-1",
      success: false,
      summary: "failed",
    });

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call"]);
    expect(stream.toolCalls[0]).toMatchObject({
      id: "tool-1",
      status: "failed",
      result: "failed",
    });
  });
});

describe("revisionBySession", () => {
  it("appendOutput bumps only its session's revision", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "hello");
    flushPendingSessionRevisionsForTests();
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(1);
    expect(useV2StreamingStore.getState().revisionBySession["s2"]).toBeUndefined();
    store.appendOutput("s1", "a1", " world");
    flushPendingSessionRevisionsForTests();
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(2);
  });

  it("tool / finalize / error mutations bump revision", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "t1", toolName: "bash", description: "", params: {},
    });
    store.setError("s1", "a1", "boom", "details");
    store.finalize("s1", "a1", "final");
    flushPendingSessionRevisionsForTests();
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(3);
  });

  it("clearStaleStreamErrors bumps revision when it removes stale errors", () => {
    const store = useV2StreamingStore.getState();
    store.setError("s1", "a1", "ACP prompt failed", "Authentication required");
    store.finishSessionActor("s1", "a1");
    flushPendingSessionRevisionsForTests();
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(2);

    store.clearStaleStreamErrors("s1", "a1");
    flushPendingSessionRevisionsForTests();
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(3);
  });

  it("appendOutputBatch bumps revision once for the whole batch", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutputBatch("s1", "a1", ["a", "b", "c"]);
    flushPendingSessionRevisionsForTests();
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(1);
    expect(useV2StreamingStore.getState().byKey["s1::a1"]?.outputText).toBe("abc");
  });

  it("coalesces multiple deltas in one frame into a single store notify", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "a");
    store.appendOutput("s1", "a1", "b");
    store.appendOutput("s1", "a1", "c");
    // Before flush: content updated, revision not yet notified
    expect(useV2StreamingStore.getState().byKey["s1::a1"]?.outputText).toBe("abc");
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBeUndefined();
    flushPendingSessionRevisionsForTests();
    expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(3);
  });

  it("still flushes when rAF never paints (occluded window)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      useV2StreamingStore.getState().appendOutput("s1", "a1", "a");
      useV2StreamingStore.getState().appendOutput("s1", "a1", "b");
      expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBeUndefined();

      vi.advanceTimersByTime(200);
      expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(2);

      useV2StreamingStore.getState().appendOutput("s1", "a1", "c");
      vi.advanceTimersByTime(200);
      expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(3);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("flushes pending bumps as soon as the window becomes visible again", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      useV2StreamingStore.getState().appendOutput("s1", "a1", "a");
      expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBeUndefined();

      document.dispatchEvent(new Event("visibilitychange"));
      expect(useV2StreamingStore.getState().revisionBySession["s1"]).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("records compaction rows on the live stream and attaches them to flushed replies", () => {
    const store = useV2StreamingStore.getState();
    store.beginCompaction("s1", "a1", {
      auto: true,
      overflow: true,
      reason: "overflow",
    });
    flushPendingSessionRevisionsForTests();
    let [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.parts.some((part) => part.type === "compaction" && !part.completed)).toBe(
      true,
    );

    store.completeCompaction("s1", "a1", {
      auto: true,
      overflow: true,
      reason: "overflow",
      tokensBefore: 1000,
      tokensAfter: 100,
    });
    flushPendingSessionRevisionsForTests();
    [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    const compactionPart = stream.parts.find((part) => part.type === "compaction");
    expect(compactionPart?.completed).toBe(true);
    expect(compactionPart?.tokensBefore).toBe(1000);

    store.attachCompactionPartsForMessage("s1", "reply-1", stream.parts.filter(
      (part) => part.type === "compaction",
    ));
    expect(store.getCompactionPartsForMessage("reply-1")).toHaveLength(1);
  });
});
