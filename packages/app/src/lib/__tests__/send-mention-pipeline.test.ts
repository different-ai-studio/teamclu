import { describe, expect, it } from "vitest";
import {
  encodeMemberMentionToken,
  expandMemberMentionTokensInText,
} from "@/lib/actor/member-mention-token";
import {
  buildStructuredMentionLines,
  hasStructuredMentionLines,
} from "@/lib/actor/outgoing-mention-content";
import { stripPickerPersonMentionsFromText } from "@/lib/actor/strip-person-mentions";

function buildOutgoingBody(
  text: string,
  agentDisplayName: string | null,
  instruction: (name: string) => string,
): string {
  let processedText = expandMemberMentionTokensInText(text, {
    humanMentionInstruction: instruction,
  });
  processedText = stripPickerPersonMentionsFromText(processedText, []);
  const parts = [
    ...buildStructuredMentionLines(
      agentDisplayName ? { displayName: agentDisplayName } : null,
    ),
  ];
  const bodyText = processedText.trim();
  if (bodyText) parts.push(bodyText);
  return parts.join("\n\n");
}

describe("send mention pipeline", () => {
  const instruction = (name: string) =>
    `This message also mentions human ${name}`;

  it("expands member token without duplicate @name in body", () => {
    const token = encodeMemberMentionToken({ id: "m1", name: "Haigang Ye" });
    const body = buildOutgoingBody(`${token} please review`, null, instruction);
    expect(body).toBe(
      "[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye] please review",
    );
    expect(body).not.toContain("@Haigang Ye");
    expect(hasStructuredMentionLines(body)).toBe(false);
  });

  it("prepends agent prefix and keeps human chip inline", () => {
    const token = encodeMemberMentionToken({ id: "m1", name: "Haigang Ye" });
    const body = buildOutgoingBody(`${token} 45678`, "MACPRO", instruction);
    expect(body).toBe(
      "[Mentioned agents: MACPRO]\n\n[Mentioned: Haigang Ye|instruction: This message also mentions human Haigang Ye] 45678",
    );
    expect(hasStructuredMentionLines(body)).toBe(true);
  });

  it("strips legacy picker @name text after expand", () => {
    const token = encodeMemberMentionToken({ id: "m1", name: "Haigang Ye" });
    let processedText = expandMemberMentionTokensInText(`${token} @Haigang Ye extra`, {
      humanMentionInstruction: instruction,
    });
    processedText = stripPickerPersonMentionsFromText(processedText, [
      { name: "Haigang Ye" },
    ]);
    const body = buildOutgoingBody(processedText, "MACPRO", instruction);
    expect(body).not.toContain("@Haigang Ye");
    expect(body).toContain("extra");
  });
});
