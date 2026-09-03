import { describe, expect, it } from "vitest";
import {
  agentReplyBodiesCollapsible,
  agentReplyTextsEquivalent,
  normalizeAgentReplyText,
  pickCanonicalAgentReplyText,
} from "@/lib/agent/agent-reply-text";

describe("agentReplyTextsEquivalent", () => {
  it("treats whitespace-only differences as equivalent", () => {
    const a = "Hello DeepSeek world.";
    const b = "Hello DeepSeek  world.";
    expect(agentReplyTextsEquivalent(a, b)).toBe(true);
    expect(normalizeAgentReplyText(a)).toBe(normalizeAgentReplyText(b));
  });

  it("picks the longer canonical body", () => {
    expect(pickCanonicalAgentReplyText("ab", "ab ")).toBe("ab ");
  });

  it("does not equate genuinely different segments", () => {
    expect(agentReplyTextsEquivalent("CPU Top 3", "Memory Top 3")).toBe(false);
  });

  it("does not equate prefix + new post-tool segment", () => {
    expect(
      agentReplyTextsEquivalent("Before tool.", "Before tool.Final answer."),
    ).toBe(false);
  });

  it("collapses acp.output vs message.created typo drift (改、 vs 改改)", () => {
    const stream =
      "好的，我整理了两种方案：\n\n**方案 A** 单文件。\n\n**方案 B** React。\n\n**我推荐方案 A**——够用、零依赖、打开即用、删除即走。适合之后想再改、加点功能时方便扩展。你觉得呢？";
    const daemon = stream.replace("再改、", "再改改、");
    expect(agentReplyTextsEquivalent(stream, daemon)).toBe(false);
    expect(agentReplyBodiesCollapsible(stream, daemon)).toBe(true);
    expect(pickCanonicalAgentReplyText(stream, daemon)).toBe(daemon);
  });
});
