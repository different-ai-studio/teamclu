/** Fields inside `[Attachment: name] ( … )` */
export type AttachmentParenInfo = {
  fullPath?: string;
  remoteUrl?: string;
  size?: string;
};

/**
 * Parse `path:` / `url:` / `size:` from the parenthesised tail. Paths may contain `)` e.g. `foo (1).exe`.
 */
export function parseAttachmentParenInfo(info: string): AttachmentParenInfo {
  const trimmed = info.trim();
  if (!trimmed) return {};

  const pathPrefix = "path:";

  if (trimmed.toLowerCase().startsWith(pathPrefix)) {
    return { fullPath: trimmed.slice(pathPrefix.length).trim() };
  }

  const urlMatch = trimmed.match(/^url:\s*(\S+)/i);
  if (urlMatch) {
    const raw = urlMatch[1].trim();
    const remoteUrl =
      raw !== "undefined" && (raw.startsWith("http://") || raw.startsWith("https://"))
        ? raw
        : undefined;
    return { remoteUrl };
  }

  const sizeMatch = trimmed.match(/^size:\s*(.+)$/i);
  if (sizeMatch) {
    return { size: sizeMatch[1].trim() };
  }

  return { size: trimmed };
}

/**
 * If `text[start]` begins `[Attachment: …] (…)`, return the span and parsed fields.
 * Uses balanced parentheses so paths like `C:\foo (1).exe` do not truncate at `)`.
 */
export function parseAttachmentTokenAt(
  text: string,
  start: number,
): { end: number; name: string; info: AttachmentParenInfo } | null {
  if (!text.slice(start).startsWith("[Attachment:")) return null;

  const nameMatch = /^\[Attachment:\s*([^\]]+)\]\s*\(/.exec(text.slice(start));
  if (!nameMatch) return null;

  const name = nameMatch[1].trim();
  const openParenOffset = start + nameMatch[0].length - 1;
  let depth = 0;
  let i = openParenOffset;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
    i++;
  }
  if (depth !== 0) return null;

  const infoRaw = text.slice(openParenOffset + 1, i - 1);
  return {
    end: i,
    name,
    info: parseAttachmentParenInfo(infoRaw),
  };
}

/** Remove `[Attachment: …] (…)` spans (balanced parens) from pasted text. */
export function stripAttachmentTokensFromText(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf("[Attachment:", i);
    if (idx === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, idx);
    const parsed = parseAttachmentTokenAt(text, idx);
    if (!parsed) {
      out += text[idx];
      i = idx + 1;
      continue;
    }
    i = parsed.end;
  }
  return out;
}