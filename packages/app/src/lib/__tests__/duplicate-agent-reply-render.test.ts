import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclu_pb";
import { mergePendingAgentReplies, rememberLiveEventId } from "@/lib/stream/live-agent-stream";
import { persistStreamingPartsForReply } from "@/lib/stream/streaming-persist";
import { adaptTeamcluMessages } from "@/lib/messages/v2-message-adapter";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

const FULL =
  "我没有物理位置 — 我运行在云端服务器上，通过 API 为你提供服务。你的请求经过 DeepSeek 的云端推理集群处理后返回结果。";

/** Output deltas from user MQTT log (single delivery). */
const OUTPUT_CHUNKS = [
  "我没有",
  "物理",
  "位置",
  " —",
  " ",
  "我",
  "运行",
  "在",
  "云端",
  "服务器",
  "上",
  "，",
  "通过",
  " API",
  " ",
  "为你",
  "提供服务",
  "。",
  "你的",
  "请求",
  "经过",
  " DeepSeek",
  " ",
  "的",
  "云端",
  "推理",
  "集群",
  "处理后",
  "返回",
  "结果",
  "。",
];

vi.mock("@/lib/cache/local-cache", () => ({
  enrichMessageParts: vi.fn(async (partsJson: string) => partsJson),
  setMessageParts: vi.fn(async (_messageId: string, partsJson: string) => partsJson),
}));

function simulateStream(duplicateDelivery: boolean) {
  const store = useV2StreamingStore.getState();
  const seen = new Set<string>();
  let eventSeq = 0;

  const deliver = (apply: () => void) => {
    const eventId = `evt-${eventSeq++}`;
    const first = rememberLiveEventId(seen, "s1", eventId);
    expect(first).toBe(true);
    if (first) apply();
    if (duplicateDelivery) {
      const second = rememberLiveEventId(seen, "s1", eventId);
      expect(second).toBe(false);
      if (second) apply();
    }
  };

  deliver(() => store.appendThinking("s1", "a1", " where"));
  deliver(() => store.appendThinking("s1", "a1", " I"));
  deliver(() => store.appendThinking("s1", "a1", "'m hosted."));

  for (const chunk of OUTPUT_CHUNKS) {
    deliver(() => store.appendOutput("s1", "a1", chunk));
  }

  return useV2StreamingStore.getState().byKey["s1::a1"];
}

beforeEach(() => {
  useV2StreamingStore.setState({ byKey: {}, archived: [], persistedPlansBySession: {} });
});

describe("duplicate agent reply root-cause checks", () => {
  it("rememberLiveEventId blocks duplicate MQTT envelopes", () => {
    const seen = new Set<string>();
    expect(rememberLiveEventId(seen, "s1", "c246c134")).toBe(true);
    expect(rememberLiveEventId(seen, "s1", "c246c134")).toBe(false);
  });

  it("duplicate acp.output delivery (dedup ON) does not double stream text", () => {
    const entry = simulateStream(true);
    expect(entry?.outputText).toBe(FULL);
    const textParts = entry?.parts.filter((p) => p.type === "text") ?? [];
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe(FULL);
  });

  it("duplicate resume re-send still merges identical chunks", () => {
    // Overlap-strip dedup now applies only to the resume/replay path
    // (mergeOverlap=true). Live duplicate delivery is handled upstream by
    // eventId dedup, not by this merge.
    const store = useV2StreamingStore.getState();
    for (const chunk of OUTPUT_CHUNKS) {
      store.appendOutput("s1", "a1", chunk, true);
      store.appendOutput("s1", "a1", chunk, true);
    }
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry?.outputText).toBe(FULL);
    expect(entry?.parts.filter((p) => p.type === "text")[0]?.text).toBe(FULL);
  });

  it("persist + adapt keeps one text part when stream text matches reply.content", async () => {
    simulateStream(false);
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    const streamText = entry?.outputText ?? "";

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: streamText,
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply);

    const parts = JSON.parse((reply as { partsJson?: string }).partsJson ?? "[]");
    const textParts = parts.filter((p: { type: string }) => p.type === "text");
    expect(textParts).toHaveLength(1);

    const sdk = adaptTeamcluMessages([reply])?.[0];
    expect(sdk?.parts.filter((p) => p.type === "text")).toHaveLength(1);
  });

  it("ingestReplyPreview does not duplicate when content matches stream outputText", () => {
    simulateStream(false);
    const before = useV2StreamingStore.getState().byKey["s1::a1"]?.outputText ?? "";
    useV2StreamingStore.getState().ingestReplyPreview("s1", "a1", before);
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry?.outputText).toBe(before);
    expect(entry?.parts.filter((p) => p.type === "text")).toHaveLength(1);
  });

  it("ingestReplyPreview does not duplicate on whitespace-only daemon final", () => {
    simulateStream(false);
    const streamText = useV2StreamingStore.getState().byKey["s1::a1"]?.outputText ?? "";
    const daemonFinal = streamText.replace("DeepSeek", "DeepSeek ");

    useV2StreamingStore.getState().ingestReplyPreview("s1", "a1", daemonFinal);
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry?.parts.filter((p) => p.type === "text")).toHaveLength(1);
    expect(entry?.outputText).toBe(daemonFinal.length >= streamText.length ? daemonFinal : streamText);
  });

  it("persist keeps one text part when merged reply was daemon+stream concat", async () => {
    const stream =
      "好的，我整理了两种方案：\n\n**方案 A** 单文件。\n\n**方案 B** React。\n\n**我推荐方案 A**——够用。适合之后想再改、加点功能。你觉得呢？";
    const daemon = stream.replace("再改、", "再改改、");
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", stream);

    const entry = store.byKey["s1::a1"];
    const merged = mergePendingAgentReplies(
      [{ messageId: "m1", content: daemon }] as never,
      entry,
    );
    expect(merged?.content).not.toContain(`${daemon}\n\n${stream}`);

    const reply = create(MessageSchema, {
      messageId: "reply-plan",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: merged?.content ?? "",
      turnId: "turn-plan",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply);
    const parts = JSON.parse((reply as { partsJson?: string }).partsJson ?? "[]");
    expect(parts.filter((p: { type: string }) => p.type === "text")).toHaveLength(1);
  });

  it("persist keeps one text part when daemon drifts from stream (改、 vs 改改)", async () => {
    const stream =
      "好的，我整理了两种方案：\n\n**方案 A** 单文件。\n\n**方案 B** React。\n\n**我推荐方案 A**——够用。适合之后想再改、加点功能。你觉得呢？";
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", stream);

    const daemon = stream.replace("再改、", "再改改、");
    const reply = create(MessageSchema, {
      messageId: "reply-plan",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: daemon,
      turnId: "turn-plan",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply, [
      { messageId: "m1", content: daemon } as never,
    ]);
    const parts = JSON.parse((reply as { partsJson?: string }).partsJson ?? "[]");
    const textParts = parts.filter((p: { type: string }) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe(stream);
    expect(reply.content).toBe(daemon);

    const sdk = adaptTeamcluMessages([reply])?.[0];
    expect(sdk?.parts.filter((p) => p.type === "text")).toHaveLength(1);
    expect((sdk?.content.match(/方案 A/g) ?? []).length).toBe(2);
  });

  it("persist keeps intro and final text parts without a merged duplicate", async () => {
    const intro = "使用 **writing-plans** 技能创建实现计划。";
    const final =
      "计划已保存到 `docs/superpowers/plans/2026-06-05-todo-website.md`。选哪种？";
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", intro);
    store.pushToolUse("s1", "a1", {
      toolId: "tool-plan",
      toolName: "skill",
      description: "writing-plans",
      params: {},
      toolKind: "other",
    });
    store.completeToolUse("s1", "a1", {
      toolId: "tool-plan",
      success: true,
      summary: "done",
    });
    store.appendOutput("s1", "a1", final);

    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    const merged = mergePendingAgentReplies(
      [
        { messageId: "m1", content: intro },
        { messageId: "m2", content: final },
      ] as never,
      entry,
    );
    expect(merged?.content).toBe(`${intro}\n\n${final}`);

    const reply = create(MessageSchema, {
      messageId: "m2",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: merged?.content ?? "",
      turnId: "turn-writing-plans",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply, [
      { messageId: "m1", content: intro },
      { messageId: "m2", content: final },
    ] as never);
    const parts = JSON.parse((reply as { partsJson?: string }).partsJson);
    const textParts = parts.filter((p: { type: string }) => p.type === "text");
    expect(textParts).toHaveLength(2);
    expect(textParts[0]?.text).toBe(intro);
    expect(textParts[1]?.text).toBe(final);
    expect((reply.content.match(/writing-plans/g) ?? []).length).toBe(1);
  });

  it("persist keeps sandwich-tool intro once in parts (ef30ac98)", async () => {
    const intro =
      "Using brainstorming to design the todo webpage. Let me first explore the project context.";
    const final =
      "这个 todo 网页是要做成一个独立的纯 HTML 文件（可以浏览器直接打开），还是要集成到 TeamClu 这个项目里作为一个新页面/组件？";
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "skill-1",
      toolName: "skill",
      description: "using-superpowers",
      params: {},
      toolKind: "other",
    });
    store.completeToolUse("s1", "a1", { toolId: "skill-1", success: true, summary: "" });
    store.pushToolUse("s1", "a1", {
      toolId: "skill-2",
      toolName: "skill",
      description: "brainstorming",
      params: {},
      toolKind: "other",
    });
    store.completeToolUse("s1", "a1", { toolId: "skill-2", success: true, summary: "" });
    store.appendOutput("s1", "a1", intro);
    store.pushToolUse("s1", "a1", {
      toolId: "read-1",
      toolName: "read",
      description: "read",
      params: {},
      toolKind: "read",
    });
    store.completeToolUse("s1", "a1", { toolId: "read-1", success: true, summary: "" });
    store.appendOutput("s1", "a1", final);

    const merged = mergePendingAgentReplies(
      [
        { messageId: "m1", content: intro },
        { messageId: "m2", content: final },
      ] as never,
      useV2StreamingStore.getState().byKey["s1::a1"],
    );
    const reply = create(MessageSchema, {
      messageId: "m2",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: merged?.content ?? "",
      turnId: "turn-ef30",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply, [
      { messageId: "m1", content: intro },
      { messageId: "m2", content: final },
    ] as never);
    const parts = JSON.parse((reply as { partsJson?: string }).partsJson);
    const textParts = parts.filter((p: { type: string }) => p.type === "text");
    expect(textParts).toHaveLength(2);
    expect(textParts[0]?.text).toBe(intro);
    expect(textParts[1]?.text).toBe(final);
    const joined = textParts.map((p: { text: string }) => p.text).join("\n");
    expect(joined.match(/brainstorming/g)?.length).toBe(1);
  });

  it("persist keeps one text part on whitespace-only reply.content mismatch", async () => {
    simulateStream(false);
    const streamText = useV2StreamingStore.getState().byKey["s1::a1"]?.outputText ?? "";
    const daemonFinal = streamText + " ";

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: daemonFinal,
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply);
    const parts = JSON.parse((reply as { partsJson?: string }).partsJson ?? "[]");
    expect(parts.filter((p: { type: string }) => p.type === "text")).toHaveLength(1);
  });
});
