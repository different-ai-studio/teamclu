import { describe, expect, it } from "vitest";
import {
  isExecutableChatFile,
  parseChatTarget,
  resolveChatPath,
  supportsSidebarPreview,
} from "@/lib/messages/chat-open-target";

describe("parseChatTarget", () => {
  it("keeps http(s) and mailto as web links", () => {
    expect(parseChatTarget("https://example.com/a")).toEqual({
      kind: "web",
      url: "https://example.com/a",
    });
    expect(parseChatTarget("mailto:a@b.c")).toEqual({ kind: "web", url: "mailto:a@b.c" });
  });

  it("ignores javascript and protocol-relative urls", () => {
    expect(parseChatTarget("javascript:alert(1)")).toEqual({ kind: "ignore" });
    expect(parseChatTarget("//cdn.example/a")).toEqual({ kind: "ignore" });
  });

  it("recognizes file urls, absolute paths, and relative paths", () => {
    expect(parseChatTarget("file:///Users/a/note.md").kind).toBe("path");
    expect(parseChatTarget("/Users/a/note.md").kind).toBe("path");
    expect(parseChatTarget("./docs/note.md").kind).toBe("path");
    expect(parseChatTarget("C:\\docs\\note.md").kind).toBe("path");
    expect(parseChatTarget("note.md").kind).toBe("ignore");
  });
});

describe("resolveChatPath", () => {
  const roots = ["/repo/app", "C:\\work\\session"];

  it("joins a relative path onto the first root that keeps it inside", () => {
    expect(resolveChatPath("./docs/周报.md", ["/repo/app"])).toBe("/repo/app/docs/周报.md");
  });

  it("allows an absolute path that sits under a root", () => {
    expect(resolveChatPath("/repo/app/docs/a.md", roots)).toBe("/repo/app/docs/a.md");
    expect(resolveChatPath("C:\\work\\session\\a.md", roots)).toBe("C:\\work\\session\\a.md");
  });

  it("rejects a path outside the session roots", () => {
    expect(resolveChatPath("/etc/passwd", roots)).toBeNull();
    expect(resolveChatPath("../secret.md", ["/repo/app"])).toBeNull();
  });

  it("turns a file url into a path and still applies the jail", () => {
    expect(resolveChatPath("file:///repo/app/docs/a.md", roots)).toBe("/repo/app/docs/a.md");
    expect(resolveChatPath("file:///etc/passwd", roots)).toBeNull();
  });
});

describe("sidebar and executable names", () => {
  it("previews markdown and html only", () => {
    expect(supportsSidebarPreview("周报.md")).toBe(true);
    expect(supportsSidebarPreview("page.HTML")).toBe(true);
    expect(supportsSidebarPreview("规格.pdf")).toBe(false);
  });

  it("treats program extensions as executable", () => {
    expect(isExecutableChatFile("setup.exe")).toBe(true);
    expect(isExecutableChatFile("run.command")).toBe(true);
    expect(isExecutableChatFile("notes.md")).toBe(false);
  });
});
