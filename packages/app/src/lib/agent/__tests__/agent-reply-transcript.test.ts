import { describe, expect, it } from "vitest";
import {
  deriveAgentReplyContent,
  isAgentFacingStatusNotice,
  joinTextPartsFromParts,
  splitAssistantProcessAndFinalParts,
  stripPriorTranscriptTextPrefix,
} from "@/lib/agent/agent-reply-transcript";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclu_pb";

describe("agent reply transcript", () => {
  it("joins multiple text parts for derived content", () => {
    const parts = [
      { type: "text", text: "Intro." },
      { type: "tool-call", toolCall: { id: "t1" } },
      { type: "text", text: "Final?" },
    ];
    expect(joinTextPartsFromParts(parts)).toBe("Intro.\n\nFinal?");
  });

  it("ignores no_final_reply agent-facing notice when deriving content", () => {
    expect(
      isAgentFacingStatusNotice(
        "[Turn completed with no final reply] The agent finished this turn",
      ),
    ).toBe(true);
    expect(
      isAgentFacingStatusNotice(
        "[Skill created in unsupported directory] A skill pack was written",
      ),
    ).toBe(true);
    const pending = [
      createMessage(MessageSchema, {
        messageId: "nfr-1",
        sessionId: "s1",
        senderActorId: "a1",
        kind: MessageKind.AGENT_REPLY,
        content:
          "[Turn completed with no final reply] The agent finished this turn without producing a final written answer.",
        metadataJson: JSON.stringify({ turn_status: "no_final_reply" }),
      }),
    ];
    expect(deriveAgentReplyContent([{ type: "tool-call", toolCall: { id: "t1" } }], pending)).toBe(
      "",
    );
  });

  it("derives content from parts for ef30ac98 sandwich tools", () => {
    const intro =
      "Using brainstorming to design the todo webpage. Let me first explore the project context.";
    const final =
      "这个 todo 网页是要做成一个独立的纯 HTML 文件（可以浏览器直接打开），还是要集成到 TeamClu 这个项目里作为一个新页面/组件？";
    const parts = [
      { type: "text", text: intro },
      { type: "tool-call", toolCall: { id: "skill" } },
      { type: "tool-call", toolCall: { id: "read" } },
      { type: "text", text: final },
    ];
    const pending = [
      { messageId: "m1", content: intro },
      { messageId: "m2", content: final },
    ] as never;
    const content = deriveAgentReplyContent(parts, pending);
    expect(content).toBe(`${intro}\n\n${final}`);
    expect(content.match(/brainstorming/g)?.length).toBe(1);
  });

  it("strips cumulative prefix before the last tool boundary", () => {
    const intro = "Using brainstorming to design the todo webpage.";
    const parts = [
      { type: "text", text: intro, content: intro },
      { type: "tool-call", toolCall: { id: "t1" } },
    ];
    const cumulative = `${intro}\n\n这个 todo 网页？`;
    expect(stripPriorTranscriptTextPrefix(parts, cumulative)).toBe("这个 todo 网页？");
    expect(stripPriorTranscriptTextPrefix(parts, "这个")).toBe("这个");
  });

  it("preserves leading spaces on incremental post-tool token deltas", () => {
    const intro = "The `issue-normalizer` skill is not available in this environment.";
    const parts = [
      { type: "text", text: intro, content: intro },
      { type: "tool-call", toolCall: { id: "t1" } },
    ];
    expect(stripPriorTranscriptTextPrefix(parts, " J")).toBe(" J");
    expect(stripPriorTranscriptTextPrefix(parts, " page")).toBe(" page");
  });

  it("merges daemon final tail when QoS0 dropped post-tool stream text", () => {
    const intro = "Intro before tools.";
    const final = "Answer after tools.";
    const parts = [
      { type: "text", text: intro },
      { type: "tool-call", toolCall: { id: "t1" } },
    ] as never;
    const pending = [{ messageId: "m1", content: final }] as never;
    expect(deriveAgentReplyContent(parts, pending)).toBe(`${intro}\n\n${final}`);
  });

  it("splits process vs final after last tool or trailing thinking", () => {
    const mid1 = "Now trying remaining tools:";
    const mid2 = "More tools:";
    const final = "全部工具执行完毕。汇总：";
    const parts = [
      { type: "reasoning", text: "plan" },
      { type: "text", text: mid1 },
      { type: "tool-call", toolCall: { id: "t1" } },
      { type: "text", text: mid2 },
      { type: "tool-call", toolCall: { id: "t2" } },
      { type: "reasoning", text: "wrap up" },
      { type: "text", text: final },
    ];
    const { processParts, finalTextParts } = splitAssistantProcessAndFinalParts(parts);
    expect(processParts.map((p) => p.type)).toEqual([
      "reasoning",
      "text",
      "tool-call",
      "text",
      "tool-call",
      "reasoning",
    ]);
    expect(finalTextParts.map((p) => (p as { text?: string }).text)).toEqual([final]);
  });

  it("treats all text as final when there is no process activity", () => {
    const parts = [{ type: "text", text: "Hello only." }];
    const { processParts, finalTextParts } = splitAssistantProcessAndFinalParts(parts);
    expect(processParts).toEqual([]);
    expect(finalTextParts).toEqual(parts);
  });

  it("does not let a trailing todowrite bury the answer in process", () => {
    const intro = "我来用 Python 为你写一个快速排序算法。";
    const answer = "这是一个标准的快速排序实现：\n\n```python\ndef quicksort(arr): ...\n```";
    const closing = "选择哪个版本取决于你的需求：";
    const parts = [
      { type: "text", text: intro },
      { type: "tool-call", toolCall: { id: "t1", name: "todowrite" } },
      { type: "text", text: answer },
      { type: "tool-call", toolCall: { id: "t2", name: "todowrite" } },
      { type: "text", text: closing },
    ];
    const { processParts, finalTextParts } = splitAssistantProcessAndFinalParts(parts);
    // Both todo calls stay visible as process, but neither anchors the boundary.
    expect(processParts.map((p) => p.type)).toEqual(["tool-call", "tool-call"]);
    expect(finalTextParts.map((p) => (p as { text?: string }).text)).toEqual([
      intro,
      answer,
      closing,
    ]);
  });

  it("still anchors the boundary on real tools when todowrite trails them", () => {
    const mid = "Let me read the file.";
    const final = "Here is what it does.";
    const parts = [
      { type: "text", text: mid },
      { type: "tool-call", toolCall: { id: "t1", name: "read" } },
      { type: "text", text: final },
      { type: "tool-call", toolCall: { id: "t2", name: "todowrite" } },
    ];
    const { processParts, finalTextParts } = splitAssistantProcessAndFinalParts(parts);
    expect(processParts.map((p) => p.type)).toEqual(["text", "tool-call", "tool-call"]);
    expect(finalTextParts.map((p) => (p as { text?: string }).text)).toEqual([final]);
  });

  it("keeps mid-turn narration in process when there is no trailing final text", () => {
    const mid = "Now trying remaining tools:";
    const parts = [
      { type: "text", text: mid },
      { type: "tool-call", toolCall: { id: "t1" } },
    ];
    const { processParts, finalTextParts } = splitAssistantProcessAndFinalParts(parts);
    expect(processParts.map((p) => p.type)).toEqual(["text", "tool-call"]);
    expect(finalTextParts).toEqual([]);
    expect(processParts.some((p) => p.type === "text")).toBe(true);
  });
});
