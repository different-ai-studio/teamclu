import { isImageFileName } from "@/lib/attachments/attachment-constants";
import { normalizeAttachmentUrl } from "@/lib/attachments/session-attachment-token";
import type { Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";

export interface AgentReplyAttachment {
  filename: string;
  mime: string;
  size: number;
  url: string;
  bucketPath?: string;
  isImage: boolean;
}

type GatewayAttachmentRow = {
  filename?: unknown;
  mime?: unknown;
  size?: unknown;
  bucket_path?: unknown;
};

function parseMetadataJson(metadataJson: string): Record<string, unknown> {
  if (!metadataJson?.trim()) return {};
  try {
    return JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isImageAttachment(mime: string, filename: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return true;
  return isImageFileName(filename);
}

function rowsFromMetadata(md: Record<string, unknown>): GatewayAttachmentRow[] {
  const raw = md.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === "object") as GatewayAttachmentRow[];
}

function urlsFromFields(
  attachmentUrls: string[] | undefined,
  md: Record<string, unknown>,
): string[] {
  if (attachmentUrls?.length) {
    return attachmentUrls.map((u) => normalizeAttachmentUrl(u)).filter(Boolean);
  }
  const metaUrls = md.attachment_urls;
  if (!Array.isArray(metaUrls)) return [];
  return metaUrls
    .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    .map((u) => normalizeAttachmentUrl(u))
    .filter(Boolean);
}

/** Resolve agent_reply attachments from proto fields and message metadata. */
export function agentReplyAttachmentsFromMessageFields(
  metadataJson: string,
  attachmentUrls: string[] = [],
): AgentReplyAttachment[] {
  const md = parseMetadataJson(metadataJson);
  const rows = rowsFromMetadata(md);
  const urls = urlsFromFields(attachmentUrls, md);

  if (rows.length > 0) {
    return rows.map((row, index) => {
      const filename =
        typeof row.filename === "string" && row.filename.trim()
          ? row.filename.trim()
          : "attachment";
      const mime = typeof row.mime === "string" ? row.mime : "";
      const size =
        typeof row.size === "number"
          ? row.size
          : typeof row.size === "string"
            ? Number(row.size) || 0
            : 0;
      const bucketPath =
        typeof row.bucket_path === "string" && row.bucket_path.trim()
          ? row.bucket_path.trim()
          : undefined;
      let url = urls[index] ?? "";
      if (!url && bucketPath) {
        const match = urls.find((u) => u.includes(encodeURIComponent(bucketPath)) || u.includes(bucketPath));
        if (match) url = match;
      }
      return {
        filename,
        mime,
        size,
        url,
        bucketPath,
        isImage: isImageAttachment(mime, filename),
      };
    });
  }

  if (urls.length === 0) return [];

  return urls.map((url) => {
    const filename = url.split("/").pop()?.split("?")[0] ?? "attachment";
    return {
      filename,
      mime: "",
      size: 0,
      url,
      isImage: isImageFileName(filename) || isImageFileName(url),
    };
  });
}

export function agentReplyAttachmentsFromTeamcluMessage(
  m: TeamcluMessage,
): AgentReplyAttachment[] {
  return agentReplyAttachmentsFromMessageFields(
    m.metadataJson ?? "",
    m.attachmentUrls ?? [],
  );
}

/** Prefer the latest agent_reply row in a turn that carries attachments. */
export function agentReplyAttachmentsFromTurnReplies(
  replies: TeamcluMessage[],
): AgentReplyAttachment[] | undefined {
  for (let i = replies.length - 1; i >= 0; i--) {
    const list = agentReplyAttachmentsFromTeamcluMessage(replies[i]!);
    if (list.length > 0) return list;
  }
  return undefined;
}
