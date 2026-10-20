import { describe, expect, it } from "vitest";

import { buildMarkdownStyles, hasBlockMarkdown } from "../features/sessions/components/markdown-styles";

const styles = buildMarkdownStyles({
  base: { fontSize: 14, lineHeight: 21 },
  hairline: 0.5,
  link: "#c00",
  rule: "#ddd",
  surface: "#eee",
  text: "#111",
});

describe("buildMarkdownStyles", () => {
  it("sizes headings near the body and gives each a line tall enough for its glyphs", () => {
    for (const key of ["heading1", "heading2", "heading3", "heading4", "heading5", "heading6"] as const) {
      const heading = styles[key];
      expect(heading.fontSize).toBeLessThanOrEqual(18);
      expect(heading.lineHeight).toBeGreaterThanOrEqual(heading.fontSize);
      expect(heading.marginTop).toBeGreaterThan(0);
    }
    expect(styles.heading1.fontSize).toBe(18);
    expect(styles.heading2.fontSize).toBe(16);
  });

  it("keeps bullets close to the body text", () => {
    expect(styles.bullet_list_icon.marginLeft).toBeLessThan(10);
    expect(styles.ordered_list_icon.marginLeft).toBeLessThan(10);
  });

  it("leaves none of the library's hardcoded greys and black", () => {
    const flat = JSON.stringify(styles);
    expect(flat).not.toMatch(/#F5F5F5|#CCC|#000000/i);
  });
});

describe("hasBlockMarkdown", () => {
  it("spots lists, headings, quotes, fences and tables", () => {
    for (const text of ["intro\n- one", "1. first", "## Title", "> quoted", "```\ncode\n```", "| a | b |"]) {
      expect(hasBlockMarkdown(text)).toBe(true);
    }
  });

  it("leaves plain and inline-formatted text alone", () => {
    for (const text of ["hello", "**bold** and `code`", "2 + 3 = 5", "#hashtag", "a - b"]) {
      expect(hasBlockMarkdown(text)).toBe(false);
    }
  });
});
