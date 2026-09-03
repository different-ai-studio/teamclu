import { describe, expect, it } from "vitest";
import { stripPickerPersonMentionsFromText } from "@/lib/actor/strip-person-mentions";

describe("stripPickerPersonMentionsFromText", () => {
  it("strips @name for picker mentions with spaced display names", () => {
    const result = stripPickerPersonMentionsFromText("@Haigang Ye 123", [
      { name: "Haigang Ye" },
    ]);
    expect(result).toBe("123");
  });

  it("strips multiple picker mentions and collapses whitespace", () => {
    const result = stripPickerPersonMentionsFromText(
      "@Alice hi @Bob there",
      [{ name: "Alice" }, { name: "Bob" }],
    );
    expect(result).toBe("hi there");
  });

  it("leaves unrelated @ tokens when not in mentions list", () => {
    const result = stripPickerPersonMentionsFromText("@Someone else", [
      { name: "Haigang Ye" },
    ]);
    expect(result).toBe("@Someone else");
  });

  it("does not strip @{filepath} file tokens", () => {
    const result = stripPickerPersonMentionsFromText("@{src/main.ts} ok", [
      { name: "src" },
    ]);
    expect(result).toBe("@{src/main.ts} ok");
  });

  it("returns empty string when body is only a picker mention", () => {
    const result = stripPickerPersonMentionsFromText("@Haigang Ye", [
      { name: "Haigang Ye" },
    ]);
    expect(result).toBe("");
  });
});
