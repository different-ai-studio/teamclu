/**
 * Markdown styling for message bubbles and agent reply cards.
 *
 * react-native-markdown-display's defaults are written for a full page, not a
 * bubble: unbolded 32/24/18pt headings with no margins (which then inherit the
 * body's ~21pt line height and overflow it), bullets indented 10pt past the
 * body text, and hardcoded `#F5F5F5` / `#CCC` / `#000000` for code, quotes,
 * tables and rules. Every key a reply commonly uses is set here so none of
 * those defaults leak through.
 *
 * `fence` is not optional decoration: the library routes ```-fenced blocks
 * through it and indented blocks through `code_block`, and agents emit fenced
 * code almost exclusively.
 */
type TextStyle = {
  fontFamily?: string;
  fontSize: number;
  fontWeight?: "400";
  lineHeight: number;
};

export type MarkdownPalette = {
  /** Body type for the bubble; headings and lists scale from its size. */
  base: TextStyle;
  text: string;
  /** Fill behind code and quotes. */
  surface: string;
  /** Quote bar, table grid and rules. */
  rule: string;
  link: string;
  /** `StyleSheet.hairlineWidth`, passed in to keep this file platform-free. */
  hairline: number;
};

function heading(fontSize: number, color: string) {
  return {
    color,
    flexDirection: "row" as const,
    fontSize,
    fontWeight: "600" as const,
    // Headings inherit the body's line height unless told otherwise; a
    // shorter line than the glyph clips it into its neighbours.
    lineHeight: Math.round(fontSize * 1.4),
    marginTop: 4,
  };
}

export function buildMarkdownStyles({ base, hairline, link, rule, surface, text }: MarkdownPalette) {
  const size = base.fontSize;
  return {
    // Blocks are spaced by the body's gap, not their own margins, so the first
    // and last add nothing and a one-line bubble keeps its usual height.
    body: { color: text, ...base, gap: 6, marginBottom: 0, marginTop: 0 },
    heading1: heading(size + 4, text),
    heading2: heading(size + 2, text),
    heading3: heading(size + 1, text),
    heading4: heading(size, text),
    heading5: heading(size, text),
    heading6: heading(size, text),
    paragraph: { color: text, marginBottom: 0, marginTop: 0 },
    strong: { fontWeight: "600" as const },
    bullet_list: { gap: 2 },
    ordered_list: { gap: 2 },
    list_item: { flexDirection: "row" as const, justifyContent: "flex-start" as const },
    bullet_list_icon: { color: text, marginLeft: 2, marginRight: 6 },
    ordered_list_icon: { color: text, marginLeft: 2, marginRight: 6 },
    bullet_list_content: { flex: 1 },
    ordered_list_content: { flex: 1 },
    hr: { backgroundColor: rule, height: hairline, marginVertical: 4 },
    code_inline: { backgroundColor: surface, borderRadius: 4, color: text, paddingHorizontal: 4 },
    code_block: { backgroundColor: surface, borderRadius: 6, color: text, padding: 8 },
    fence: { backgroundColor: surface, borderRadius: 6, color: text, padding: 8 },
    blockquote: {
      backgroundColor: surface,
      borderColor: rule,
      borderLeftWidth: 3,
      marginLeft: 0,
      paddingHorizontal: 8,
    },
    table: { borderColor: rule, borderRadius: 4, borderWidth: hairline },
    tr: { borderBottomWidth: hairline, borderColor: rule },
    th: { color: text, padding: 6 },
    td: { color: text, padding: 6 },
    link: { color: link, textDecorationLine: "underline" as const },
  };
}

/**
 * Whether `text` has block markdown — a list, heading, quote, fence or table.
 *
 * A bubble that sizes to its content (`maxWidth` with no width) lays such
 * blocks out in rows, and Yoga can wrap them differently while measuring the
 * bubble than when drawing it: the bubble comes out short and the last lines
 * spill past it. Those bubbles take their full width instead.
 */
export function hasBlockMarkdown(text: string): boolean {
  return /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\|)/m.test(text);
}
