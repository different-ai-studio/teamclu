import type { MentionedPerson } from "@/packages/ai/prompt-input-types";
import { buildHumanMentionChip } from "@/lib/outgoing-mention-content";
const MEMBER_MENTION_TOKEN_RE = /@\{member:([^|]+)\|([^}]+)\}/g;

export function encodeMemberMentionToken(person: {
  id: string;
  name: string;
}): string {
  return `@{member:${person.id}|${encodeURIComponent(person.name)}}`;
}

export function parseMemberMentionBody(body: string): MentionedPerson | null {
  if (!body.startsWith("member:")) return null;
  const rest = body.slice("member:".length);
  const pipe = rest.indexOf("|");
  if (pipe < 0) return null;
  const id = rest.slice(0, pipe).trim();
  const encodedName = rest.slice(pipe + 1);
  if (!id || !encodedName) return null;
  try {
    const name = decodeURIComponent(encodedName);
    if (!name.trim()) return null;
    return { id, name };
  } catch {
    return null;
  }
}

export function parseMemberMentionsFromText(text: string): MentionedPerson[] {
  const seen = new Map<string, MentionedPerson>();
  for (const match of text.matchAll(MEMBER_MENTION_TOKEN_RE)) {
    const id = match[1]?.trim();
    const encodedName = match[2];
    if (!id || !encodedName) continue;
    try {
      const name = decodeURIComponent(encodedName);
      if (!name.trim() || seen.has(id)) continue;
      seen.set(id, { id, name });
    } catch {
      continue;
    }
  }
  return [...seen.values()];
}

export function expandMemberMentionTokensInText(
  text: string,
  options?: {
    humanMentionInstruction?: (displayName: string) => string;
  },
): string {
  return text.replace(MEMBER_MENTION_TOKEN_RE, (_full, _id, encodedName) => {
    try {
      const name = decodeURIComponent(encodedName);
      if (!name.trim()) return _full;
      const instruction = options?.humanMentionInstruction?.(name);
      return buildHumanMentionChip(name, instruction);
    } catch {
      return _full;
    }
  });
}

export function stripMemberMentionTokensFromText(text: string): string {
  return text
    .replace(/@\{member:[^}]+\}\s?/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function textHasMemberMentionTokens(text: string): boolean {
  MEMBER_MENTION_TOKEN_RE.lastIndex = 0;
  return MEMBER_MENTION_TOKEN_RE.test(text);
}
