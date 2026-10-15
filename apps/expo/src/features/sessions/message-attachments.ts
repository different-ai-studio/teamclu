import type { MessageAttachment } from "./session-types";

/**
 * Where a message's files live on the wire. FC stores nothing from a
 * top-level `attachments` field — every producer puts them in `metadata`:
 *
 * - iOS writes `metadata.attachments` as `{filename, mime, size, bucket_path}`
 *   (`CloudInsertMessageMetadata`), and reads only that.
 * - Desktop writes `metadata.attachment_urls` (public object URLs).
 * - Agent replies carry both.
 *
 * Expo writes both too, so every client reads it back, and reads either.
 */
type AttachmentRef = {
  filename: string;
  mime: string;
  size: number;
  bucket_path: string | null;
};

/** The object's path inside the attachments bucket, from its public URL. */
export function bucketPathFromAttachmentUrl(url: string): string | null {
  const clean = url.split("#")[0]?.split("?")[0] ?? "";
  const match = /\/attachments\/(.+)$/.exec(clean.replace(/\/attachments\/attachments\//, "/attachments/"));
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The `metadata` keys that carry `attachments`; empty when there are none. */
export function attachmentMetadata(
  attachments: readonly MessageAttachment[] | undefined,
): { attachments?: AttachmentRef[]; attachment_urls?: string[] } {
  if (!attachments || attachments.length === 0) return {};
  const refs = attachments.map<AttachmentRef>((attachment) => {
    const bucketPath = attachment.path || bucketPathFromAttachmentUrl(attachment.url);
    return {
      filename: (bucketPath ?? attachment.url).split("/").pop() || "attachment",
      mime: attachment.mime || "application/octet-stream",
      size: attachment.size ?? 0,
      bucket_path: bucketPath,
    };
  });
  const urls = attachments.map((attachment) => attachment.url).filter((url) => /^https?:\/\//i.test(url));
  return {
    attachments: refs,
    ...(urls.length > 0 ? { attachment_urls: urls } : {}),
  };
}

/** Public URLs to hand the agent with the live message (proto `attachment_urls`). */
export function attachmentUrlsForAgent(attachments: readonly MessageAttachment[] | undefined): string[] {
  return (attachments ?? []).map((attachment) => attachment.url).filter((url) => /^https?:\/\//i.test(url));
}

/** `GET /v1/attachments/:path` — needs the caller's bearer (see `attachment-image-source`). */
export function attachmentDownloadUrl(baseUrl: string, bucketPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/attachments/${encodeURIComponent(bucketPath)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sizeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Files on an older Expo row, or one already mapped (`{url, path, mime, size}`). */
function legacyAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: MessageAttachment[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push({ url: entry });
    } else if (isRecord(entry) && typeof entry.url === "string" && entry.url) {
      out.push({
        url: entry.url,
        path: stringOrUndefined(entry.path),
        mime: stringOrUndefined(entry.mime),
        size: sizeOf(entry.size),
      });
    }
  }
  return out;
}

/**
 * A message's files, from wherever its producer put them. `baseUrl` is the
 * Cloud API origin, used for a file known only by its bucket path (an iOS
 * upload); without it such a file is skipped.
 */
export function attachmentsFromMessage(
  metadata: unknown,
  legacy: unknown,
  baseUrl: string | null,
): MessageAttachment[] | undefined {
  const md = isRecord(metadata) ? metadata : {};
  const urls = Array.isArray(md.attachment_urls)
    ? md.attachment_urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
    : [];
  const refs = Array.isArray(md.attachments) ? md.attachments.filter(isRecord) : [];

  const out: MessageAttachment[] = [];
  const usedUrls = new Set<string>();
  for (const ref of refs) {
    const bucketPath = stringOrUndefined(ref.bucket_path);
    const matchingUrl = bucketPath
      ? urls.find((url) => !usedUrls.has(url) && bucketPathFromAttachmentUrl(url) === bucketPath)
      : undefined;
    const url = matchingUrl ?? (bucketPath && baseUrl ? attachmentDownloadUrl(baseUrl, bucketPath) : undefined);
    if (!url) continue;
    if (matchingUrl) usedUrls.add(matchingUrl);
    out.push({ url, path: bucketPath, mime: stringOrUndefined(ref.mime), size: sizeOf(ref.size) });
  }
  // URLs no ref described — a desktop message, or a ref without a path.
  for (const url of urls) {
    if (usedUrls.has(url)) continue;
    out.push({ url, path: bucketPathFromAttachmentUrl(url) ?? undefined, mime: mimeFromName(url) });
  }
  if (out.length === 0) out.push(...legacyAttachments(legacy));
  return out.length > 0 ? out : undefined;
}

function mimeFromName(url: string): string | undefined {
  const lower = url.split("?")[0]?.toLowerCase() ?? "";
  if (/\.(png)$/.test(lower)) return "image/png";
  if (/\.(jpe?g)$/.test(lower)) return "image/jpeg";
  if (/\.(heic|heif)$/.test(lower)) return "image/heic";
  if (/\.(gif)$/.test(lower)) return "image/gif";
  if (/\.(webp)$/.test(lower)) return "image/webp";
  if (/\.(m4a)$/.test(lower)) return "audio/mp4";
  if (/\.(pdf)$/.test(lower)) return "application/pdf";
  return undefined;
}
