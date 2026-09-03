import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclu_pb";
import { adaptTeamcluMessages } from "@/lib/messages/v2-message-adapter";
import { hydrateDeferredProcessParts } from "@/lib/stream/lazy-process-parts";

// Simple counter for stable IDs in tests (avoids crypto.randomUUID dependency)
let _idCounter = 0;
function nextId() {
  return `msg-${++_idCounter}`;
}

function tmsg(o: {
  id?: string;
  senderActorId?: string;
  kind?: MessageKind;
  content?: string;
  metadataJson?: string;
  model?: string;
  turnId?: string;
  replyToMessageId?: string;
  t?: number;
  sessionId?: string;
  sequence?: number;
  partsJson?: string;
}) {
  const msg = create(MessageSchema, {
    messageId: o.id ?? nextId(),
    sessionId: o.sessionId ?? "s1",
    senderActorId: o.senderActorId ?? "actor-a",
    kind: o.kind ?? MessageKind.AGENT_REPLY,
    content: o.content ?? "",
    metadataJson: o.metadataJson ?? "",
    model: o.model ?? "",
    turnId: o.turnId ?? "",
    replyToMessageId: o.replyToMessageId ?? "",
    createdAt: BigInt(o.t ?? 0),
  });
  if (o.sequence !== undefined) {
    Object.assign(msg, { sequence: BigInt(o.sequence) });
  }
  if (o.partsJson !== undefined) {
    Object.assign(msg, { partsJson: o.partsJson });
  }
  return msg;
}

describe("adaptTeamcluMessages", () => {
  it("returns undefined when input is undefined", () => {
    expect(adaptTeamcluMessages(undefined)).toBeUndefined();
  });

  it("passes through messages with empty turnId 1:1 (legacy/non-agent)", () => {
    const msgs = [
      tmsg({ kind: MessageKind.TEXT, content: "hello", turnId: "" }),
      tmsg({ kind: MessageKind.TEXT, content: "world", turnId: "" }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("hello");
    expect(result[1].content).toBe("world");
    expect(result[0].role).toBe("user");
  });

  it("keeps routing mentions as metadata without adding them to user content", () => {
    const msgs = [
      tmsg({
        kind: MessageKind.TEXT,
        content: "执行pwd",
        metadataJson: JSON.stringify({
          mention_actor_ids: ["actor-mac2"],
          display_mention_actor_ids: ["actor-mac2"],
        }),
        turnId: "",
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("执行pwd");
    expect(result[0].mentionActorIds).toEqual(["actor-mac2"]);
  });

  it("passes through SYSTEM messages with turnId (kindToRole → not assistant)", () => {
    // SYSTEM is role 'system' not 'assistant', so it bypasses grouping
    const msgs = [
      tmsg({ kind: MessageKind.SYSTEM, content: "sys", turnId: "t1" }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("sys");
  });

  it("single AGENT_REPLY with turnId → single SdkMessage (same content)", () => {
    const id = nextId();
    const msgs = [
      tmsg({ id, kind: MessageKind.AGENT_REPLY, content: "hi", turnId: "t2", t: 1000 }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(id);
    expect(result[0].content).toBe("hi");
    expect(result[0].role).toBe("assistant");
    expect(result[0].timestamp).toEqual(new Date(1000 * 1000));
  });

  it("thinking + 2 replies same turnId → one SdkMessage with joined content and reasoning part", () => {
    const msgs = [
      tmsg({ kind: MessageKind.AGENT_THINKING, content: "Let me think...", turnId: "t3", t: 1 }),
      tmsg({ kind: MessageKind.AGENT_REPLY, content: "First part", turnId: "t3", t: 2 }),
      tmsg({ kind: MessageKind.AGENT_REPLY, content: "Second part", turnId: "t3", t: 3 }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.content).toBe("First part\n\nSecond part");
    expect(msg.role).toBe("assistant");

    // reasoning part should be present
    const reasoningPart = msg.parts.find((p) => p.type === "reasoning");
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.text).toBe("Let me think...");
    expect(reasoningPart!.content).toBe("Let me think...");

    // text part also present
    const textPart = msg.parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart!.text).toBe("First part\n\nSecond part");

    // timestamp is the earliest (group[0])
    expect(msg.timestamp).toEqual(new Date(1 * 1000));
  });

  it("dedupes repeated same-turn AGENT_REPLY rows from live cache plus Supabase replay", () => {
    const msgs = [
      tmsg({
        id: "live-short-id",
        kind: MessageKind.AGENT_REPLY,
        content: "你好，Ye。",
        turnId: "turn-dup",
        t: 100,
      }),
      tmsg({
        id: "11111111-1111-1111-1111-111111111111",
        kind: MessageKind.AGENT_REPLY,
        content: "你好，Ye。",
        turnId: "turn-dup",
        t: 101,
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("你好，Ye。");
    expect(result[0].parts.find((p) => p.type === "text")?.text).toBe("你好，Ye。");
  });

  it("tool_call + tool_result + reply same turnId → one SdkMessage with completed toolCall", () => {
    const toolId = "tool-xyz";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "bash", description: "run ls" }),
        turnId: "t4",
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "file1.txt\nfile2.txt",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId: "t4",
        t: 2,
      }),
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "Done listing files.",
        turnId: "t4",
        t: 3,
      }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.content).toBe("Done listing files.");
    expect(msg.toolCalls).toHaveLength(1);

    const tc = msg.toolCalls![0];
    expect(tc.id).toBe(toolId);
    expect(tc.name).toBe("bash");
    expect(tc.status).toBe("completed");
    expect(tc.result).toBe("file1.txt\nfile2.txt");
    expect(tc.arguments).toEqual({ _description: "run ls" });

    // No reasoning part
    expect(msg.parts.find((p) => p.type === "reasoning")).toBeUndefined();
  });

  it("restores JSON tool descriptions as structured arguments", () => {
    const toolId = "tool-json-description";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({
          tool_id: toolId,
          tool_name: "bash",
          description: '{"command":"ps aux"}',
        }),
        turnId: "json-description",
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "pid command",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId: "json-description",
        t: 2,
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result[0].toolCalls?.[0].arguments).toMatchObject({
      command: "ps aux",
    });
    expect(result[0].parts[0].toolCall?.arguments).toMatchObject({
      command: "ps aux",
    });
  });

  it("restores persisted tool params alongside descriptions", () => {
    const toolId = "tool-params";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({
          tool_id: toolId,
          tool_name: "bash",
          description: "Execute ps command",
          params: { command: "ps aux" },
        }),
        turnId: "params-turn",
        t: 1,
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result[0].toolCalls?.[0].arguments).toMatchObject({
      _description: "Execute ps command",
      command: "ps aux",
    });
  });

  it("orders persisted tool calls before the final reply when they happened first", () => {
    const toolId = "tool-before-text";
    const msgs = [
      tmsg({
        id: "a-call",
        kind: MessageKind.AGENT_TOOL_CALL,
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "grep", description: "search text" }),
        turnId: "ordered-realistic",
        t: 10,
      }),
      tmsg({
        id: "b-result",
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "match",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId: "ordered-realistic",
        t: 11,
      }),
      tmsg({
        id: "c-reply",
        kind: MessageKind.AGENT_REPLY,
        content: "I found one match.",
        turnId: "ordered-realistic",
        t: 12,
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("I found one match.");
    expect(result[0].parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
    expect(result[0].parts[0].toolCall?.id).toBe(toolId);
    expect(result[0].parts[1].text).toBe("I found one match.");
  });

  it("uses persisted canonical parts_json for reload parity", () => {
    const parts = [
      {
        id: "p1",
        type: "text",
        text: "Before tool.",
        content: "Before tool.",
      },
      {
        id: "tool-part",
        type: "tool-call",
        toolCallId: "tool-1",
        toolCall: {
          id: "tool-1",
          name: "bash",
          toolKind: "execute",
          status: "completed",
          arguments: { command: "ps aux" },
          startTime: "2026-05-25T00:00:00.000Z",
          result: "ok",
        },
      },
      {
        id: "p2",
        type: "text",
        text: "After tool.",
        content: "After tool.",
      },
    ];
    const msgs = [
      tmsg({
        id: "first-reply",
        kind: MessageKind.AGENT_REPLY,
        content: "Before tool.",
        turnId: "parts-json-turn",
        t: 10,
      }),
      tmsg({
        id: "final-reply",
        kind: MessageKind.AGENT_REPLY,
        content: "After tool.",
        turnId: "parts-json-turn",
        t: 12,
        partsJson: JSON.stringify(parts),
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("final-reply");
    expect(result[0].content).toBe("Before tool.\n\nAfter tool.");
    expect(result[0].parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(result[0].toolCalls?.[0].status).toBe("completed");
    expect(result[0].toolCalls?.[0].startTime).toEqual(new Date("2026-05-25T00:00:00.000Z"));
  });

  it("merges disjoint per-reply parts_json from the same turn (8644132b)", () => {
    const firstParts = [
      {
        id: "p1",
        type: "text",
        text: "使用 brainstorming 技能。",
        content: "使用 brainstorming 技能。",
      },
      {
        id: "tool-1",
        type: "tool-call",
        toolCallId: "todowrite",
        toolCall: {
          id: "todowrite",
          name: "todowrite",
          status: "completed",
          arguments: {},
          startTime: "2026-05-25T00:00:00.000Z",
          result: "ok",
        },
      },
    ];
    const secondParts = [
      {
        id: "p2",
        type: "text",
        text: "Want to try canvas?",
        content: "Want to try canvas?",
      },
    ];
    const msgs = [
      tmsg({
        id: "reply-1",
        kind: MessageKind.AGENT_REPLY,
        content: "使用 brainstorming 技能。",
        turnId: "turn-split",
        t: 10,
        partsJson: JSON.stringify(firstParts),
      }),
      tmsg({
        id: "reply-2",
        kind: MessageKind.AGENT_REPLY,
        content: "Want to try canvas?",
        turnId: "turn-split",
        t: 12,
        partsJson: JSON.stringify(secondParts),
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("reply-2");
    expect(result[0].content).toBe(
      "使用 brainstorming 技能。\n\nWant to try canvas?",
    );
    expect(result[0].parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(result[0].parts[0].text).toBe("使用 brainstorming 技能。");
    expect(result[0].parts[2].text).toBe("Want to try canvas?");
  });

  it("prefers a duplicate reply that carries persisted parts_json", () => {
    const toolId = "tool-with-output";
    const parts = [
      {
        id: "tool-part",
        type: "tool-call",
        toolCallId: toolId,
        toolCall: {
          id: toolId,
          name: "bash",
          toolKind: "execute",
          status: "completed",
          arguments: {
            command: "ps -o pid,%cpu,%mem,comm -r | head -10",
            description: "Top 10 processes by CPU",
          },
          startTime: "2026-05-25T00:00:00.000Z",
          result: "PID  %CPU %MEM COMM\n50369 22.6 1.5 opencode",
        },
      },
      {
        id: "reply-text",
        type: "text",
        text: "已执行 `ps`。",
        content: "已执行 `ps`。",
      },
    ];
    const msgs = [
      tmsg({
        id: "tool-call",
        kind: MessageKind.AGENT_TOOL_CALL,
        metadataJson: JSON.stringify({
          tool_id: toolId,
          tool_name: "bash",
          description: "Top 10 processes by CPU",
          params: { command: "ps -o pid,%cpu,%mem,comm -r | head -10" },
        }),
        turnId: "duplicate-parts-json-turn",
        t: 10,
      }),
      tmsg({
        id: "tool-result",
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "Top 10 processes by CPU",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId: "duplicate-parts-json-turn",
        t: 11,
      }),
      tmsg({
        id: "remote-reply",
        kind: MessageKind.AGENT_REPLY,
        content: "已执行 `ps`。",
        turnId: "duplicate-parts-json-turn",
        t: 12,
      }),
      tmsg({
        id: "local-reply-with-parts",
        kind: MessageKind.AGENT_REPLY,
        content: "已执行 `ps`。",
        turnId: "duplicate-parts-json-turn",
        t: 13,
        partsJson: JSON.stringify(parts),
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("local-reply-with-parts");
    expect(result[0].toolCalls?.[0].result).toContain("50369");
    expect(result[0].parts[0].toolCall?.result).toContain("opencode");
  });

  it("preserves interleaved reply/tool/reply order inside one turn", () => {
    const toolId = "tool-between-text";
    const msgs = [
      tmsg({
        id: "a-reply",
        kind: MessageKind.AGENT_REPLY,
        content: "I will check the file.",
        turnId: "ordered-interleaved",
        t: 10,
      }),
      tmsg({
        id: "b-call",
        kind: MessageKind.AGENT_TOOL_CALL,
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "read", description: "read file" }),
        turnId: "ordered-interleaved",
        t: 11,
      }),
      tmsg({
        id: "c-result",
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "file contents",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId: "ordered-interleaved",
        t: 12,
      }),
      tmsg({
        id: "d-reply",
        kind: MessageKind.AGENT_REPLY,
        content: "The file says hello.",
        turnId: "ordered-interleaved",
        t: 13,
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("I will check the file.\n\nThe file says hello.");
    expect(result[0].parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(result[0].parts[0].text).toBe("I will check the file.");
    expect(result[0].parts[1].toolCall?.id).toBe(toolId);
    expect(result[0].parts[2].text).toBe("The file says hello.");
  });

  // Rows that share a timestamp keep the caller's order (the sort is stable).
  // Ids here deliberately sort the opposite way to prove they are not consulted.
  it("keeps caller order for rows sharing the same timestamp", () => {
    const toolId = "tool-same-time";
    const msgs = [
      tmsg({
        id: "z-call",
        kind: MessageKind.AGENT_TOOL_CALL,
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "search", description: "search" }),
        turnId: "ordered-tie",
        t: 10,
      }),
      tmsg({
        id: "y-result",
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "ok",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId: "ordered-tie",
        t: 10,
      }),
      tmsg({
        id: "x-reply",
        kind: MessageKind.AGENT_REPLY,
        content: "Done.",
        turnId: "ordered-tie",
        t: 10,
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;

    expect(result[0].parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
    expect(result[0].parts[0].toolCall?.id).toBe(toolId);
  });

  it("tool_call without matching result → ToolCall with status 'calling'", () => {
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        metadataJson: JSON.stringify({ tool_id: "t-orphan", tool_name: "search", description: "search web" }),
        turnId: "t5",
        t: 1,
      }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);

    const tc = result[0].toolCalls![0];
    expect(tc.status).toBe("calling");
    expect(tc.id).toBe("t-orphan");
    expect(tc.result).toBeUndefined();
  });

  it("mixed: messages with turnId collapse, messages without stay 1:1", () => {
    const userMsg = tmsg({ kind: MessageKind.TEXT, content: "user question", turnId: "", t: 1 });
    const agentReply1 = tmsg({ kind: MessageKind.AGENT_REPLY, content: "part A", turnId: "t6", t: 10 });
    const agentReply2 = tmsg({ kind: MessageKind.AGENT_REPLY, content: "part B", turnId: "t6", t: 11 });
    const anotherUser = tmsg({ kind: MessageKind.TEXT, content: "follow-up", turnId: "", t: 20 });

    const msgs = [userMsg, agentReply1, agentReply2, anotherUser];
    const result = adaptTeamcluMessages(msgs)!;

    // user + collapsed group + user = 3 messages
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("user question");

    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("part A\n\npart B");

    expect(result[2].role).toBe("user");
    expect(result[2].content).toBe("follow-up");
  });

  it("different senderActorIds with same turnId are NOT merged (separate groups)", () => {
    // Same turnId but different senderActorId → each forms its own group
    const msgs = [
      tmsg({ senderActorId: "actor-a", kind: MessageKind.AGENT_REPLY, content: "from A", turnId: "t7", t: 1 }),
      tmsg({ senderActorId: "actor-b", kind: MessageKind.AGENT_REPLY, content: "from B", turnId: "t7", t: 2 }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("from A");
    expect(result[1].content).toBe("from B");
  });

  it("replays ACP content from tool metadata on reload", () => {
    const toolId = "t-diff-replay";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        metadataJson: JSON.stringify({
          tool_id: toolId,
          tool_name: "write",
          description: "",
          content: [
            { type: "diff", path: "src/a.ts", old_text: "a", new_text: "ab" },
          ],
        }),
        turnId: "t-diff",
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "done",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId: "t-diff",
        t: 2,
      }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result[0].toolCalls![0].content?.[0]?.type).toBe("diff");
  });

  it("no replies but has tool calls → SdkMessage with empty content and toolCalls[]", () => {
    const toolId = "t-call-only";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "write_file", description: "" }),
        turnId: "t8",
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "ok",
        metadataJson: JSON.stringify({ tool_id: toolId, success: false }),
        turnId: "t8",
        t: 2,
      }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("");
    expect(result[0].toolCalls).toHaveLength(1);
    expect(result[0].toolCalls![0].status).toBe("failed");
  });

  it("modelID comes from the last AGENT_REPLY in the group", () => {
    const msgs = [
      tmsg({ kind: MessageKind.AGENT_REPLY, content: "a", model: "model-old", turnId: "t9", t: 1 }),
      tmsg({ kind: MessageKind.AGENT_REPLY, content: "b", model: "model-new", turnId: "t9", t: 2 }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);
    expect(result[0].modelID).toBe("model-new");
  });

  it("sorts messages by createdAt ascending before grouping", () => {
    // Provide messages out of order — after sort they should group correctly
    const msgs = [
      tmsg({ kind: MessageKind.AGENT_REPLY, content: "second", turnId: "t10", t: 20 }),
      tmsg({ kind: MessageKind.AGENT_REPLY, content: "first", turnId: "t10", t: 10 }),
    ];
    const result = adaptTeamcluMessages(msgs)!;
    expect(result).toHaveLength(1);
    // earliest timestamp wins for the group timestamp
    expect(result[0].timestamp).toEqual(new Date(10 * 1000));
    // content joined in sorted order
    expect(result[0].content).toBe("first\n\nsecond");
  });

  it("passes replyToMessageId through single and grouped turns", () => {
    const single = adaptTeamcluMessages([
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "hi",
        turnId: "t-reply",
        replyToMessageId: "user-1",
      }),
    ]);
    expect(single?.[0]?.replyToMessageId).toBe("user-1");

    const grouped = adaptTeamcluMessages([
      tmsg({
        kind: MessageKind.AGENT_THINKING,
        content: "think",
        turnId: "t-g",
        replyToMessageId: "",
      }),
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "done",
        turnId: "t-g",
        replyToMessageId: "user-9",
      }),
    ]);
    expect(grouped?.[0]?.replyToMessageId).toBe("user-9");
  });

  it("keeps replyToMessageId on mergedPersistedParts path (completed stream)", () => {
    const partsJson = JSON.stringify([
      { id: "p1", type: "reasoning", text: "think", content: "think" },
      { id: "p2", type: "text", text: "final", content: "final" },
    ]);
    const result = adaptTeamcluMessages([
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "final",
        turnId: "t-parts",
        replyToMessageId: "user-parent",
        partsJson,
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.replyToMessageId).toBe("user-parent");
    expect(result?.[0]?.turnId).toBe("t-parts");
    expect(result?.[0]?.parts?.some((p) => p.type === "text")).toBe(true);
  });

  // The gateway writes the inbound WeCom message and the agent reply back to
  // back, so both land in the same whole second once createdAt is truncated.
  // The reply's id is a random UUID and the user message's is the WeCom msgid,
  // so an id tiebreak flipped the pair for roughly half of all turns.
  it("keeps caller order for same-second messages whose ids sort the wrong way", () => {
    const result = adaptTeamcluMessages([
      tmsg({
        id: "CAcQAB1234567890",
        kind: MessageKind.TEXT,
        content: "得",
        turnId: "",
        t: 1_753_500_000,
      }),
      tmsg({
        id: "a1b2c3d4-0000-4000-8000-000000000000",
        kind: MessageKind.AGENT_REPLY,
        content: "😄 还想来一首吗?",
        turnId: "",
        t: 1_753_500_000,
      }),
    ])!;
    expect(result.map((m) => m.content)).toEqual(["得", "😄 还想来一首吗?"]);
  });

  it("maps interrupted AGENT_REPLY metadata to turnStatus and hides agent-facing body", () => {
    const result = adaptTeamcluMessages([
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content:
          "[Turn interrupted by user] The user stopped this turn before it finished.",
        turnId: "t-int",
        metadataJson: JSON.stringify({ turn_status: "interrupted" }),
        replyToMessageId: "user-sleep",
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.turnStatus).toBe("interrupted");
    expect(result?.[0]?.content).toBe("");
    expect(result?.[0]?.replyToMessageId).toBe("user-sleep");
    expect(result?.[0]?.parts ?? []).toEqual([]);
  });

  it("maps unsupported native skill AGENT_REPLY metadata to turnStatus and violations", () => {
    const result = adaptTeamcluMessages([
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content:
          "[Skill created in unsupported directory] A skill pack was written under a native agent directory.",
        turnId: "t-native",
        metadataJson: JSON.stringify({
          turn_status: "skill_created_in_unsupported_directory",
          error_code: "skill_created_in_unsupported_directory",
          violations: [{ slug: "demo", root: ".opencode/skills", path: "/ws/.opencode/skills/demo" }],
        }),
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.turnStatus).toBe("skill_created_in_unsupported_directory");
    expect(result?.[0]?.content).toBe("");
    expect(result?.[0]?.nativeSkillViolations).toEqual([
      { slug: "demo", root: ".opencode/skills", path: "/ws/.opencode/skills/demo" },
    ]);
  });

  it("maps no_final_reply AGENT_REPLY metadata to turnStatus and hides agent-facing body", () => {
    const result = adaptTeamcluMessages([
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content:
          "[Turn completed with no final reply] The agent finished this turn without producing a final written answer.",
        turnId: "t-nfr",
        metadataJson: JSON.stringify({ turn_status: "no_final_reply" }),
        replyToMessageId: "user-tools",
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.turnStatus).toBe("no_final_reply");
    expect(result?.[0]?.content).toBe("");
    expect(result?.[0]?.replyToMessageId).toBe("user-tools");
    expect(result?.[0]?.parts ?? []).toEqual([]);
  });

  it("keeps generated prose on interrupted AGENT_REPLY and sets turnStatus", () => {
    const prose = "暮色从城市的边缘慢慢漫上来……";
    const result = adaptTeamcluMessages([
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: prose,
        turnId: "t-prose-int",
        metadataJson: JSON.stringify({ turn_status: "interrupted" }),
        replyToMessageId: "user-prose",
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.turnStatus).toBe("interrupted");
    expect(result?.[0]?.content).toBe(prose);
    expect(result?.[0]?.parts?.some((p) => p.type === "text" && p.text === prose)).toBe(
      true,
    );
  });

  it("defers completed turn process parts when final reply text exists", () => {
    const toolId = "tool-defer";
    const turnId = "t-defer";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_THINKING,
        content: "Planning…",
        turnId,
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "read", description: "open file" }),
        turnId,
        t: 2,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "ok",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId,
        t: 3,
      }),
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "Final answer.",
        turnId,
        t: 4,
      }),
    ];

    const result = adaptTeamcluMessages(msgs, { deferProcess: true })!;
    expect(result).toHaveLength(1);
    expect(result[0].processDeferred).toBe(true);
    expect(result[0].processMeta).toEqual({ toolCount: 1, hasThinking: true });
    expect(result[0].content).toBe("Final answer.");
    expect(result[0].toolCalls).toEqual([]);
    expect(result[0].parts.some((p) => p.type === "tool-call")).toBe(false);
    expect(result[0].parts.some((p) => p.type === "reasoning")).toBe(false);
  });

  it("forceFull adapt matches hydrated deferred process parts", () => {
    const toolId = "tool-hydrate";
    const turnId = "t-hydrate";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "bash", description: "ls" }),
        turnId,
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "a.txt",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId,
        t: 2,
      }),
      tmsg({
        kind: MessageKind.AGENT_REPLY,
        content: "Here are the files.",
        turnId,
        t: 3,
      }),
    ];

    const deferred = adaptTeamcluMessages(msgs, { deferProcess: true })!;
    const full = adaptTeamcluMessages(msgs, { forceFull: true })!;

    expect(deferred[0].processDeferred).toBe(true);
    expect(full[0].processDeferred).toBeUndefined();
    expect(full[0].toolCalls).toHaveLength(1);

    const hydrated = hydrateDeferredProcessParts(msgs, deferred[0]);
    const fullToolParts = full[0].parts.filter((p) => p.type === "tool-call");
    const hydratedToolParts = hydrated.filter((p) => p.type === "tool-call");
    expect(hydratedToolParts).toHaveLength(fullToolParts.length);
    expect(hydratedToolParts[0]?.toolCall?.name).toBe("bash");
  });

  it("does not defer tool-only turns without separate final text", () => {
    const toolId = "tool-only";
    const turnId = "t-tool-only";
    const msgs = [
      tmsg({
        kind: MessageKind.AGENT_TOOL_CALL,
        content: "",
        metadataJson: JSON.stringify({ tool_id: toolId, tool_name: "bash", description: "pwd" }),
        turnId,
        t: 1,
      }),
      tmsg({
        kind: MessageKind.AGENT_TOOL_RESULT,
        content: "/home/user",
        metadataJson: JSON.stringify({ tool_id: toolId, success: true }),
        turnId,
        t: 2,
      }),
    ];

    const result = adaptTeamcluMessages(msgs)!;
    expect(result[0].processDeferred).toBeUndefined();
    expect(result[0].toolCalls).toHaveLength(1);
  });
});
