import type { SessionAttachmentRef } from "@/lib/attachments/session-attachments";
import { base64urlDecode, base64urlEncode } from "@/lib/embed/page-link-token";

const SESSION_ATTACHMENT_PREFIX = "att:b64:";

export interface SessionAttachmentPayload {
  name: string;
  url: string;
  isImage: boolean;
  /** Storage path when known — used to rebuild stable public URLs at send time. */
  path?: string;
}

/** Strip signed-URL query tokens and fragments; public bucket URLs stay fetchable. */
export function normalizeAttachmentUrl(url: string): string {
  const withoutFragment = url.split("#")[0];
  return withoutFragment.split("?")[0];
}

/** Extract object path from TeamClu public attachment URLs (Supabase or OSS). */
export function parseStoragePathFromAttachmentUrl(url: string): string | null {
  const normalized = normalizeAttachmentUrl(url);
  const supabase = normalized.match(/\/storage\/v1\/object\/public\/attachments\/(.+)$/);
  if (supabase) {
    try {
      return decodeURIComponent(supabase[1]);
    } catch {
      return supabase[1];
    }
  }
  const oss = normalized.match(/\/attachments\/attachments\/(.+)$/);
  if (oss) {
    try {
      return decodeURIComponent(oss[1]);
    } catch {
      return oss[1];
    }
  }
  return null;
}

function rebuildAttachmentPublicUrl(path: string, referenceUrl: string): string | null {
  const normalized = normalizeAttachmentUrl(referenceUrl);
  const supabasePrefix = normalized.match(/^(.*\/storage\/v1\/object\/public\/attachments\/)/);
  if (supabasePrefix) {
    return `${supabasePrefix[1]}${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  const ossPrefix = normalized.match(/^(.*\/attachments\/attachments\/)/);
  if (ossPrefix) {
    return `${ossPrefix[1]}${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  return null;
}

/** Resolve a session attachment to a stable fetch URL before send / metadata. */
export function resolveSessionAttachmentUrl(
  ref: Pick<SessionAttachmentPayload, "url" | "path">,
): string {
  const normalized = normalizeAttachmentUrl(ref.url);
  const path = ref.path ?? parseStoragePathFromAttachmentUrl(normalized);
  if (path) {
    const rebuilt = rebuildAttachmentPublicUrl(path, normalized);
    if (rebuilt) return rebuilt;
  }
  return normalized;
}

export function encodeSessionAttachmentToken(
  ref: Pick<SessionAttachmentRef, "name" | "url" | "isImage"> & { path?: string },
): string {
  const path = ref.path ?? parseStoragePathFromAttachmentUrl(ref.url) ?? undefined;
  const json = JSON.stringify({
    name: ref.name,
    url: ref.url,
    isImage: ref.isImage,
    ...(path ? { path } : {}),
  } satisfies SessionAttachmentPayload);
  return `@{${SESSION_ATTACHMENT_PREFIX}${base64urlEncode(json)}}`;
}

export function parseSessionAttachmentBody(body: string): SessionAttachmentPayload | null {
  if (!body.startsWith(SESSION_ATTACHMENT_PREFIX)) return null;
  const encoded = body.slice(SESSION_ATTACHMENT_PREFIX.length);
  if (!encoded) return null;
  try {
    const json = base64urlDecode(encoded);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as SessionAttachmentPayload;
    if (
      typeof p.name !== "string" ||
      typeof p.url !== "string" ||
      typeof p.isImage !== "boolean" ||
      !p.url.trim()
    ) {
      return null;
    }
    if (p.path !== undefined && typeof p.path !== "string") return null;
    return { name: p.name, url: p.url, isImage: p.isImage, path: p.path };
  } catch {
    return null;
  }
}

export function parseSessionAttachmentToken(token: string): SessionAttachmentPayload | null {
  if (!token.startsWith("@{") || !token.endsWith("}")) return null;
  return parseSessionAttachmentBody(token.slice(2, -1));
}

const SESSION_ATTACHMENT_TOKEN_RE = /@\{att:b64:[^}]+\}/g;

export function parseSessionAttachmentTokensFromText(
  text: string,
): SessionAttachmentPayload[] {
  const seen = new Map<string, SessionAttachmentPayload>();
  for (const match of text.matchAll(SESSION_ATTACHMENT_TOKEN_RE)) {
    const token = match[0];
    const payload = parseSessionAttachmentToken(token);
    if (!payload) continue;
    const url = resolveSessionAttachmentUrl(payload);
    const dedupeKey = payload.path ?? url;
    if (seen.has(dedupeKey)) continue;
    seen.set(dedupeKey, { ...payload, url });
  }
  return [...seen.values()];
}

export function textHasSessionAttachmentTokens(text: string): boolean {
  SESSION_ATTACHMENT_TOKEN_RE.lastIndex = 0;
  return SESSION_ATTACHMENT_TOKEN_RE.test(text);
}

export function expandSessionAttachmentTokensInText(text: string): string {
  return text.replace(SESSION_ATTACHMENT_TOKEN_RE, (token) => {
    const ref = parseSessionAttachmentToken(token);
    if (!ref) return token;
    const url = resolveSessionAttachmentUrl(ref);
    if (ref.isImage) {
      return `[Image: ${ref.name}] (url: ${url})`;
    }
    return `[Attachment: ${ref.name}] (url: ${url})`;
  });
}

export function collectSessionAttachmentUrlsFromText(text: string): string[] {
  return parseSessionAttachmentTokensFromText(text).map((ref) => ref.url);
}
