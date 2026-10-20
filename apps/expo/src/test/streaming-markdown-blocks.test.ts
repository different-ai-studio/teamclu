import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "../features/sessions/components/streaming-markdown-blocks";

describe("splitMarkdownBlocks", () => {
  it("splits at blank lines", () => {
    expect(splitMarkdownBlocks("# Title\n\nPara one\nstill one\n\n- a\n- b")).toEqual([
      "# Title",
      "Para one\nstill one",
      "- a\n- b",
    ]);
  });

  it("keeps a fence whole, blank lines and all, even while it is still open", () => {
    const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    expect(splitMarkdownBlocks(text)).toEqual([
      "Intro",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "After",
    ]);
    expect(splitMarkdownBlocks("```\nline\n\nmore")).toEqual(["```\nline\n\nmore"]);
  });

  it("only closes a fence with the same marker, at least as long", () => {
    expect(splitMarkdownBlocks("````\n```\n\nx\n````\n\ny")).toEqual(["````\n```\n\nx\n````", "y"]);
  });

  it("leaves earlier blocks unchanged as the text grows", () => {
    const before = splitMarkdownBlocks("Para one\n\nPara tw");
    const after = splitMarkdownBlocks("Para one\n\nPara two is longer");
    expect(after[0]).toBe(before[0]);
  });
});
