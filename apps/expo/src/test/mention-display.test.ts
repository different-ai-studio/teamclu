import { describe, expect, it } from "vitest";

import { mentionPlainText, mentionSegments } from "../features/sessions/mention-display";

const S = (kind: "text" | "mention" | "invocation", text: string) => ({ kind, text });

// Same cases as iOS MentionDisplayTextTests.
describe("mentionSegments", () => {
  it("leaves a plain message untouched", () => {
    expect(mentionSegments("hello\nworld")).toEqual([S("text", "hello\nworld")]);
  });

  it("turns the leading agent line into a mention", () => {
    expect(mentionSegments("[Mentioned agents: SPRBOT]\n\n深圳宝安有什么推荐的美食?")).toEqual([
      S("mention", "@SPRBOT"),
      S("text", " 深圳宝安有什么推荐的美食?"),
    ]);
  });

  it("lists several leading lines", () => {
    expect(mentionSegments("[Mentioned agents: A, B]\n[Mentioned humans: C]\nhi")).toEqual([
      S("mention", "@A"), S("text", " "), S("mention", "@B"), S("text", " "), S("mention", "@C"), S("text", " hi"),
    ]);
  });

  it("drops instructions and scaffolding when there is no body", () => {
    const raw = "[Mentioned agents: 研小蕉 Bot]\n\n[Mentioned: 周金亮 |instruction: 这条信息还提及了人类 周金亮]";
    expect(mentionSegments(raw)).toEqual([S("mention", "@研小蕉 Bot"), S("text", " "), S("mention", "@周金亮")]);
    expect(mentionPlainText(raw)).toBe("@研小蕉 Bot @周金亮");
  });

  it("handles an inline human chip mid-sentence", () => {
    expect(mentionSegments("[Mentioned: Haigang Ye|instruction: 提及 Haigang Ye] 帮我看下结算")).toEqual([
      S("mention", "@Haigang Ye"),
      S("text", " 帮我看下结算"),
    ]);
  });

  it("turns skill and role chips into invocations", () => {
    const raw =
      '[Skill: issue-normalizer|instruction:You must call skill({ name: "issue-normalizer" }) before any other action.] fix [Role: reviewer|instruction:x]';
    expect(mentionSegments(raw)).toEqual([
      S("invocation", "/issue-normalizer"),
      S("text", " fix "),
      S("invocation", "/reviewer"),
    ]);
  });

  it("leaves ordinary brackets alone", () => {
    expect(mentionSegments("see [docs] and [Mentioned agents: x] later")).toEqual([
      S("text", "see [docs] and [Mentioned agents: x] later"),
    ]);
  });
});
