import type { Message } from "@/lib/proto/teamclu_pb";
import { isImageFileName } from "@/lib/attachments/attachment-constants";
import { normalizeAttachmentUrl } from "@/lib/attachments/session-attachment-token";

export interface SessionAttachmentRef {
  name: string;
  url: string;
  isImage: boolean;
  /** Unix seconds — latest message that referenced this URL. */
  lastSeenAt: number;
}

const IMAGE_TOKEN =
  /\[Image:\s*([^\]]+)\]\s*\(url:\s*(https?:\/\/[^)]+)\)/gi;
const ATTACHMENT_TOKEN =
  /\[Attachment:\s*([^\]]+)\]\s*\(url:\s*(https?:\/\/[^)]+)\)/gi;

function parseTokensFromText(
  text: string,
  createdAt: number,
  byUrl: Map<string, SessionAttachmentRef>,
): void {
  for (const pattern of [IMAGE_TOKEN, ATTACHMENT_TOKEN]) {
    const isImagePattern = pattern === IMAGE_TOKEN;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim();
      const url = normalizeAttachmentUrl(match[2].trim());
      if (!url || url === "undefined") continue;
      const existing = byUrl.get(url);
      if (existing) {
        if (createdAt >= existing.lastSeenAt) {
          existing.lastSeenAt = createdAt;
          existing.name = name;
        }
      } else {
        byUrl.set(url, {
          name,
          url,
          isImage: isImagePattern,
          lastSeenAt: createdAt,
        });
      }
    }
  }
}

/** Collect unique session attachments from message bodies, newest first. */
export function collectSessionAttachments(
  messages: Message[] | undefined,
): SessionAttachmentRef[] {
  if (!messages?.length) return [];
  const byUrl = new Map<string, SessionAttachmentRef>();

  for (const msg of messages) {
    const createdAt = Number(msg.createdAt ?? 0);
    parseTokensFromText(msg.content ?? "", createdAt, byUrl);
    let metaUrls: string[] | undefined;
    if (msg.metadataJson) {
      try {
        const parsed = JSON.parse(msg.metadataJson) as { attachment_urls?: string[] };
        metaUrls = parsed.attachment_urls;
      } catch {
        metaUrls = undefined;
      }
    }
    if (metaUrls?.length) {
      for (const rawUrl of metaUrls) {
        if (!rawUrl) continue;
        const url = normalizeAttachmentUrl(rawUrl);
        if (byUrl.has(url)) continue;
        const name = url.split("/").pop()?.split("?")[0] ?? "attachment";
        byUrl.set(url, {
          name,
          url,
          isImage: isImageFileName(name) || isImageFileName(url),
          lastSeenAt: createdAt,
        });
      }
    }
  }

  return Array.from(byUrl.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
