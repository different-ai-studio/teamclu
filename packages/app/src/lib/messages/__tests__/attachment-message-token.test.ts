import { describe, expect, it } from "vitest";

import {
  parseAttachmentTokenAt,
  parseAttachmentParenInfo,
  stripAttachmentTokensFromText,
} from "../attachment-message-token";

describe("parseAttachmentParenInfo", () => {
  it("keeps parentheses in windows paths", () => {
    expect(parseAttachmentParenInfo("path: C:\\Users\\me\\CursorUserSetup (1).exe")).toEqual({
      fullPath: "C:\\Users\\me\\CursorUserSetup (1).exe",
    });
  });
});

describe("parseAttachmentTokenAt", () => {
  it("parses a full local attachment token", () => {
    const content =
      "hi [Attachment: CursorUserSetup (1).exe] (path: D:\\Downloads\\CursorUserSetup (1).exe) bye";
    const parsed = parseAttachmentTokenAt(content, content.indexOf("[Attachment:"));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("CursorUserSetup (1).exe");
    expect(parsed!.info.fullPath).toBe("D:\\Downloads\\CursorUserSetup (1).exe");
    expect(content.slice(parsed!.end)).toBe(" bye");
  });

  it("strips attachment tokens with parenthesised paths from pasted text", () => {
    const pasted =
      "x\n[Attachment: CursorUserSetup (1).exe] (path: D:\\Downloads\\CursorUserSetup (1).exe)\ny";
    expect(stripAttachmentTokensFromText(pasted)).toBe("x\n\ny");
    expect(stripAttachmentTokensFromText(pasted)).not.toContain(".exe)");
  });

  it("does not leave trailing .exe) as unconsumed text", () => {
    const token =
      "[Attachment: WorkBuddy.exe] (path: C:\\Apps\\WorkBuddy (x64).exe)";
    const parsed = parseAttachmentTokenAt(token, 0);
    expect(parsed?.end).toBe(token.length);
  });
});