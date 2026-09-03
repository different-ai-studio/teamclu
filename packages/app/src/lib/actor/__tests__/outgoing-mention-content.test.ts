import { describe, expect, it } from "vitest";
import {
  buildEnhancedChip,
  buildHumanMentionChip,
  buildStructuredMentionLines,
  hasStructuredMentionLines,
} from "@/lib/actor/outgoing-mention-content";
import { expandMemberMentionTokensInText } from "@/lib/actor/member-mention-token";

describe("outgoing-mention-content", () => {
  it("builds agent prefix line only", () => {
    expect(buildStructuredMentionLines({ displayName: "MACPRO" })).toEqual([
      "[Mentioned agents: MACPRO]",
    ]);
    expect(buildStructuredMentionLines(null)).toEqual([]);
  });

  it("builds human mention chip with default English instruction", () => {
    expect(buildHumanMentionChip("Haigang Ye")).toBe(
      "[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye]",
    );
  });

  it("builds human mention chip with custom instruction", () => {
    expect(
      buildHumanMentionChip("Haigang Ye", "这条信息还提及了人类 Haigang Ye"),
    ).toBe(
      "[Mentioned: Haigang Ye|instruction: 这条信息还提及了人类 Haigang Ye]",
    );
  });

  it("builds opencode skill/role chips with plugin tool calls", () => {
    expect(buildEnhancedChip("skill", "issue-normalizer")).toBe(
      '[Skill: issue-normalizer|instruction:You must call skill({ name: "issue-normalizer" }) before any other action.]',
    );
    expect(buildEnhancedChip("skill", "issue-normalizer", "opencode")).toBe(
      '[Skill: issue-normalizer|instruction:You must call skill({ name: "issue-normalizer" }) before any other action.]',
    );
    expect(buildEnhancedChip("role", "reviewer", "opencode")).toBe(
      '[Role: reviewer|instruction:You must call role_load({ name: "reviewer" }) before any other action.]',
    );
  });

  it("builds claude-code skill chips around the native Skill tool", () => {
    const chip = buildEnhancedChip("skill", "issue-normalizer", "claude-code");
    expect(chip).toBe(
      '[Skill: issue-normalizer|instruction:You must run the "issue-normalizer" skill (via your Skill tool) before any other action.]',
    );
    // The wrapper shape must stay parseable by UserMessageWithMentions.
    expect(chip).toMatch(/^\[Skill: issue-normalizer\|instruction:[^\]]+\]$/);
  });

  it("detects structured agent mention lines", () => {
    expect(hasStructuredMentionLines("[Mentioned agents: MACPRO]\n\nhi")).toBe(true);
    expect(
      hasStructuredMentionLines(
        "[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye]",
      ),
    ).toBe(false);
  });
});

describe("expandMemberMentionTokensInText", () => {
  it("replaces wire tokens with human mention chips", () => {
    const token = "@{member:m1|Haigang%20Ye}";
    expect(expandMemberMentionTokensInText(`${token} 123`)).toBe(
      "[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye] 123",
    );
  });

  it("uses custom instruction callback when provided", () => {
    const token = "@{member:m1|Haigang%20Ye}";
    expect(
      expandMemberMentionTokensInText(`${token} 123`, {
        humanMentionInstruction: (name) => `提及 ${name}`,
      }),
    ).toBe("[Mentioned: Haigang Ye|instruction: 提及 Haigang Ye] 123");
  });
});
