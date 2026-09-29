import { describe, expect, it } from "vitest";
import { linkifyHttpUrls } from "@/lib/messages/linkify-http";

describe("linkifyHttpUrls", () => {
  it("returns plain text when there is no http(s) url", () => {
    expect(linkifyHttpUrls("hello world")).toEqual([{ type: "text", text: "hello world" }]);
    expect(linkifyHttpUrls("javascript:alert(1)")).toEqual([
      { type: "text", text: "javascript:alert(1)" },
    ]);
    expect(linkifyHttpUrls("file:///etc/passwd")).toEqual([
      { type: "text", text: "file:///etc/passwd" },
    ]);
  });

  it("turns a bare http(s) url into a link and leaves surrounding text", () => {
    expect(linkifyHttpUrls("see https://example.com/docs please")).toEqual([
      { type: "text", text: "see " },
      { type: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
      { type: "text", text: " please" },
    ]);
    expect(linkifyHttpUrls("http://example.com/a")).toEqual([
      { type: "link", text: "http://example.com/a", href: "http://example.com/a" },
    ]);
  });

  it("keeps trailing punctuation outside the link", () => {
    expect(linkifyHttpUrls("go https://example.com/docs.")).toEqual([
      { type: "text", text: "go " },
      { type: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
      { type: "text", text: "." },
    ]);
    expect(linkifyHttpUrls("看 https://example.com/docs。")).toEqual([
      { type: "text", text: "看 " },
      { type: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
      { type: "text", text: "。" },
    ]);
    expect(linkifyHttpUrls("(https://example.com/a)")).toEqual([
      { type: "text", text: "(" },
      { type: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { type: "text", text: ")" },
    ]);
  });

  it("keeps balanced parentheses that belong to the url", () => {
    const url = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
    expect(linkifyHttpUrls(url)).toEqual([{ type: "link", text: url, href: url }]);
  });

  it("linkifies every bare url in the string", () => {
    expect(linkifyHttpUrls("https://a.example/x and https://b.example/y")).toEqual([
      { type: "link", text: "https://a.example/x", href: "https://a.example/x" },
      { type: "text", text: " and " },
      { type: "link", text: "https://b.example/y", href: "https://b.example/y" },
    ]);
  });
});
