/**
 * Derive session attachment list items from message rows (metadata-only).
 * Mirrors packages/app agent-reply-attachments + session-attachments metadata paths.
 */

export type SessionAttachmentExtractRow = {
  id: string;
  kind: string;
  metadata: unknown;
  senderActorId: string | null;
  createdAt: string;
};

export type ExtractedSessionAttachment = {
  filename: string;
  mime: string | null;
  size: number | null;
  storagePath: string;
  url: string;
  messageId: string;
  senderActorId: string | null;
  attachedAt: string;
};

export function normalizeAttachmentUrl(url: string): string {
  const withoutFragment = url.split("#")[0];
  return withoutFragment.split("?")[0];
}

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

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}

function urlsFromMetadata(md: Record<string, unknown>): string[] {
  const raw = md.attachment_urls;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    .map((u) => normalizeAttachmentUrl(u))
    .filter(Boolean);
}

function dedupeKey(storagePath: string, url: string): string {
  return storagePath || url;
}

function filenameFromUrl(url: string): string {
  return url.split("/").pop()?.split("?")[0] ?? "attachment";
}

function extractHumanAttachments(row: SessionAttachmentExtractRow): ExtractedSessionAttachment[] {
  const md = parseMetadata(row.metadata);
  const urls = urlsFromMetadata(md);
  if (urls.length === 0) return [];

  return urls.map((url) => {
    const pathFromUrl = parseStoragePathFromAttachmentUrl(url);
    const storagePath = pathFromUrl ?? url;
    return {
      filename: filenameFromUrl(url),
      mime: null,
      size: null,
      storagePath,
      url,
      messageId: row.id,
      senderActorId: row.senderActorId,
      attachedAt: row.createdAt,
    };
  });
}

type AgentAttachmentRow = {
  filename?: unknown;
  mime?: unknown;
  size?: unknown;
  bucket_path?: unknown;
};

function extractAgentAttachments(row: SessionAttachmentExtractRow): ExtractedSessionAttachment[] {
  const md = parseMetadata(row.metadata);
  const urls = urlsFromMetadata(md);
  const raw = md.attachments;
  const rows = Array.isArray(raw)
    ? raw.filter((item) => item && typeof item === "object") as AgentAttachmentRow[]
    : [];

  if (rows.length > 0) {
    return rows.map((item, index) => {
      const filename =
        typeof item.filename === "string" && item.filename.trim()
          ? item.filename.trim()
          : "attachment";
      const mime = typeof item.mime === "string" ? item.mime : null;
      let size: number | null = null;
      if (typeof item.size === "number" && Number.isFinite(item.size)) {
        size = item.size;
      } else if (typeof item.size === "string") {
        const n = Number(item.size);
        size = Number.isFinite(n) ? n : null;
      }
      const bucketPath =
        typeof item.bucket_path === "string" && item.bucket_path.trim()
          ? item.bucket_path.trim()
          : "";
      let url = urls[index] ?? "";
      if (!url && bucketPath) {
        const match = urls.find(
          (u) => u.includes(encodeURIComponent(bucketPath)) || u.includes(bucketPath),
        );
        if (match) url = match;
      }
      const pathFromUrl = url ? parseStoragePathFromAttachmentUrl(url) : null;
      const storagePath = bucketPath || pathFromUrl || url || filename;
      return {
        filename,
        mime,
        size,
        storagePath,
        url,
        messageId: row.id,
        senderActorId: row.senderActorId,
        attachedAt: row.createdAt,
      };
    }).filter((item) => item.storagePath && (item.url || item.filename));
  }

  if (urls.length === 0) return [];

  return urls.map((url) => ({
    filename: filenameFromUrl(url),
    mime: null,
    size: null,
    storagePath: parseStoragePathFromAttachmentUrl(url) ?? url,
    url,
    messageId: row.id,
    senderActorId: row.senderActorId,
    attachedAt: row.createdAt,
  }));
}

export function extractSessionAttachmentsFromMessage(
  row: SessionAttachmentExtractRow,
): ExtractedSessionAttachment[] {
  if (row.kind === "agent_reply") {
    return extractAgentAttachments(row);
  }
  return extractHumanAttachments(row);
}

/** Merge rows; same storagePath/url key keeps the newest attachedAt. */
export function dedupeSessionAttachments(
  items: ExtractedSessionAttachment[],
): ExtractedSessionAttachment[] {
  const byKey = new Map<string, ExtractedSessionAttachment>();
  for (const item of items) {
    const key = dedupeKey(item.storagePath, item.url);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || item.attachedAt > existing.attachedAt) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.attachedAt !== b.attachedAt) return a.attachedAt > b.attachedAt ? -1 : 1;
    if (a.storagePath !== b.storagePath) return a.storagePath > b.storagePath ? -1 : 1;
    return a.messageId > b.messageId ? -1 : a.messageId < b.messageId ? 1 : 0;
  });
}
