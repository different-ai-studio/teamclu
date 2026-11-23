import { getBackend } from "@/lib/backend/provider";
import type { AgentReplyAttachment } from "@/lib/attachments/agent-reply-attachments";

async function fetchRemoteBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const STORAGE_PUBLIC_PATH_MARKERS = [
  "/storage/v1/object/public/attachments/",
  "/storage/v1/object/authenticated/attachments/",
] as const;

/** Extract object path from Supabase-style public attachment URLs. */
export function storagePathFromPublicAttachmentUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    for (const marker of STORAGE_PUBLIC_PATH_MARKERS) {
      const index = pathname.indexOf(marker);
      if (index === -1) continue;
      const encoded = pathname.slice(index + marker.length);
      return decodeURIComponent(encoded);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveAgentReplyAttachmentStoragePath(
  item: Pick<AgentReplyAttachment, "bucketPath" | "url">,
): string | undefined {
  const bucket = item.bucketPath?.trim();
  if (bucket) return bucket;
  if (item.url) return storagePathFromPublicAttachmentUrl(item.url);
  return undefined;
}

/** Authenticated Cloud API download when we know the storage path; else direct URL. */
export async function fetchAgentReplyAttachmentBytes(
  item: AgentReplyAttachment,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const storagePath = resolveAgentReplyAttachmentStoragePath(item);
  if (storagePath) {
    return getBackend().attachments.downloadByStoragePath(storagePath);
  }
  if (item.url) {
    const bytes = await fetchRemoteBytes(item.url);
    return { bytes, contentType: "application/octet-stream" };
  }
  throw new Error("Attachment has no URL or storage path");
}
