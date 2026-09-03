import { describe, expect, it } from "vitest";
import {
  encodeMemberMentionToken,
  parseMemberMentionBody,
  parseMemberMentionsFromText,
  stripMemberMentionTokensFromText,
} from "@/lib/actor/member-mention-token";

describe("member-mention-token", () => {
  const person = { id: "actor-1", name: "Haigang Ye" };

  it("round-trips encode and parse", () => {
    const token = encodeMemberMentionToken(person);
    expect(token).toBe("@{member:actor-1|Haigang%20Ye}");
    expect(parseMemberMentionBody("member:actor-1|Haigang%20Ye")).toEqual(person);
    expect(parseMemberMentionsFromText(`${token} hello`)).toEqual([person]);
  });

  it("strips member tokens from send body", () => {
    const token = encodeMemberMentionToken(person);
    expect(stripMemberMentionTokensFromText(`${token} 123`)).toBe("123");
  });

  it("dedupes repeated member tokens by id", () => {
    const token = encodeMemberMentionToken(person);
    expect(parseMemberMentionsFromText(`${token} ${token}`)).toEqual([person]);
  });
});
