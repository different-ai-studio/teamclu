/**
 * Turns the structured tokens the desktop composer writes into a message into
 * what a reader should see — iOS `MentionDisplayText` (#1584):
 *
 * - a leading `[Mentioned agents: A, B]` / `[Mentioned humans: C]` line → `@A @B @C`
 * - an inline `[Mentioned: Name|instruction: …]` chip → `@Name`
 * - `[Skill: x|…]`, `[Role: x|…]`, `[Command: x|…]` → `/x`
 *
 * Every `|instruction:` payload is meant for the model and is dropped. Shown
 * raw, they buried the message under prompt scaffolding.
 */
export type MentionSegment = { kind: "text" | "mention" | "invocation"; text: string };

const LEADING_LINE = /^\[Mentioned (?:agents|humans): ([^\]]*)\][ \t]*\r?\n?/;
const INLINE_CHIP = /\[(Mentioned|Skill|Role|Command): ([^\]]+)\]/g;

const at = (name: string) => (name.startsWith("@") ? name : `@${name}`);

function stripInstruction(raw: string): string {
  const trimmed = raw.trim();
  const i = trimmed.indexOf("|instruction:");
  return i < 0 ? trimmed : trimmed.slice(0, i).trim();
}

function splitNames(list: string): string[] {
  return list.split(",").map((n) => n.trim()).filter(Boolean);
}

export function mentionSegments(raw: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let body = raw;

  const leading: string[] = [];
  for (let m = LEADING_LINE.exec(body); m; m = LEADING_LINE.exec(body)) {
    leading.push(...splitNames(m[1]));
    body = body.slice(m[0].length);
  }
  if (leading.length > 0) {
    body = body.replace(/^\s+/, "");
    leading.forEach((name, i) => {
      if (i > 0) out.push({ kind: "text", text: " " });
      out.push({ kind: "mention", text: at(name) });
    });
    if (body) out.push({ kind: "text", text: " " });
  }

  let cursor = 0;
  for (const m of body.matchAll(INLINE_CHIP)) {
    const start = m.index ?? 0;
    if (cursor < start) out.push({ kind: "text", text: body.slice(cursor, start) });
    const label = m[1];
    const name = stripInstruction(m[2]);
    if (name) {
      if (label === "Mentioned") {
        splitNames(name).forEach((person, i) => {
          if (i > 0) out.push({ kind: "text", text: " " });
          out.push({ kind: "mention", text: at(person) });
        });
      } else {
        out.push({ kind: "invocation", text: `/${name}` });
      }
    }
    cursor = start + m[0].length;
  }
  if (cursor < body.length) out.push({ kind: "text", text: body.slice(cursor) });

  // Join adjacent text runs, then trim what a removed token left at the ends.
  const merged: MentionSegment[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (seg.kind === "text" && last?.kind === "text") last.text += seg.text;
    else merged.push({ ...seg });
  }
  if (merged[0]?.kind === "text") {
    merged[0].text = merged[0].text.replace(/^\s+/, "");
    if (!merged[0].text) merged.shift();
  }
  const tail = merged[merged.length - 1];
  if (tail?.kind === "text") {
    tail.text = tail.text.replace(/\s+$/, "");
    if (!tail.text) merged.pop();
  }
  return merged;
}

/** The message as plain text with tokens rewritten — for bubbles, previews, copy. */
export function mentionPlainText(raw: string): string {
  return mentionSegments(raw).map((s) => s.text).join("");
}
