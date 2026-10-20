export type HttpTextSegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string };

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

const TRAILING_PUNCTUATION = new Set(
  Array.from(".,;:!?)]}>\"'`。，、；：！？）】》」』"),
);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function countChar(value: string, ch: string): number {
  let count = 0;
  for (const c of value) {
    if (c === ch) count += 1;
  }
  return count;
}

/** Drop punctuation that was stuck to the end of a URL, keeping balanced brackets. */
function splitTrailingPunctuation(raw: string): { href: string; trailing: string } {
  let href = raw;
  const trailing: string[] = [];
  while (href.length > 0) {
    const ch = href[href.length - 1];
    if (!TRAILING_PUNCTUATION.has(ch)) break;
    if (ch === ")" || ch === "）") {
      const opens = countChar(href, "(") + countChar(href, "（");
      const closes = countChar(href, ")") + countChar(href, "）");
      if (closes <= opens) break;
    }
    if (ch === "]" || ch === "】") {
      const opens = countChar(href, "[") + countChar(href, "【");
      const closes = countChar(href, "]") + countChar(href, "】");
      if (closes <= opens) break;
    }
    trailing.push(ch);
    href = href.slice(0, -1);
  }
  return { href, trailing: trailing.reverse().join("") };
}

export function linkifyHttpUrls(input: string): HttpTextSegment[] {
  if (!input) return [{ type: "text", text: input }];

  const segments: HttpTextSegment[] = [];
  let cursor = 0;
  for (const match of input.matchAll(HTTP_URL_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const { href, trailing } = splitTrailingPunctuation(raw);
    if (!isHttpUrl(href)) continue;

    if (index > cursor) {
      segments.push({ type: "text", text: input.slice(cursor, index) });
    }
    segments.push({ type: "link", text: href, href });
    if (trailing) {
      segments.push({ type: "text", text: trailing });
    }
    cursor = index + raw.length;
  }

  if (cursor < input.length) {
    segments.push({ type: "text", text: input.slice(cursor) });
  }
  if (segments.length === 0) {
    return [{ type: "text", text: input }];
  }
  return segments;
}
