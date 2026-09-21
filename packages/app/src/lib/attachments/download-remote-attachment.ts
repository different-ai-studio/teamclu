import i18n from "@/lib/i18n";
import { getBackend } from "@/lib/backend/provider";
import type { AgentReplyAttachment } from "@/lib/attachments/agent-reply-attachments";
import {
  attachmentPathExists,
  getCachedAttachmentPath,
  normalizeAttachmentUrlKey,
  removeCachedAttachmentPath,
  setCachedAttachmentPath,
} from "@/lib/attachments/attachment-download-index";
import { revealInFinder } from "@/components/workspace/file-tree-operations";
import { isTauri } from "@/lib/utils";

type AttachmentOpenResult = "revealed" | "downloaded" | "cancelled";

function extensionFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ext && ext !== filename.toLowerCase() ? ext : "bin";
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim() || "attachment";
  return trimmed.replace(/[/\\?%*:|"<>]/g, "_");
}

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

async function downloadViaBrowser(url: string, filename: string): Promise<void> {
  const bytes = await fetchRemoteBytes(url);
  const blob = new Blob([Uint8Array.from(bytes)]);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function downloadViaTauri(url: string, filename: string): Promise<string | null> {
  const [{ save }, { writeFile }, { downloadDir }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);

  const safeName = sanitizeFilename(filename);
  const ext = extensionFromFilename(safeName);
  const downloads = await downloadDir();
  const dest = await save({
    title: i18n.t("chat.attachment.saveAttachment", "Save attachment"),
    defaultPath: `${downloads}/${safeName}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!dest) return null;

  const bytes = await fetchRemoteBytes(url);
  await writeFile(dest, bytes);
  return dest;
}

/**
 * Desktop: reveal a previously saved file in Finder, or prompt save + download.
 * Browser: always triggers a download (no folder reveal).
 */
export async function openOrDownloadRemoteAttachment(
  url: string,
  filename: string,
): Promise<AttachmentOpenResult> {
  const safeName = sanitizeFilename(filename);

  if (isTauri()) {
    const urlKey = normalizeAttachmentUrlKey(url);
    const cachedPath = getCachedAttachmentPath(urlKey);

    if (cachedPath && (await attachmentPathExists(cachedPath))) {
      await revealInFinder(cachedPath);
      return "revealed";
    }

    if (cachedPath) {
      removeCachedAttachmentPath(urlKey);
    }

    const dest = await downloadViaTauri(url, safeName);
    if (!dest) return "cancelled";

    setCachedAttachmentPath(urlKey, dest, safeName);
    await revealInFinder(dest);
    return "downloaded";
  }

  await downloadViaBrowser(url, safeName);
  return "downloaded";
}

async function downloadBytesViaBrowser(bytes: Uint8Array, filename: string, mime: string) {
  const blob = new Blob([Uint8Array.from(bytes)], { type: mime || "application/octet-stream" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = sanitizeFilename(filename);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function downloadBytesViaTauri(
  bytes: Uint8Array,
  filename: string,
): Promise<string | null> {
  const [{ save }, { writeFile }, { downloadDir }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);
  const safeName = sanitizeFilename(filename);
  const ext = extensionFromFilename(safeName);
  const downloads = await downloadDir();
  const dest = await save({
    title: i18n.t("chat.attachment.saveAttachment", "Save attachment"),
    defaultPath: `${downloads}/${safeName}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!dest) return null;
  await writeFile(dest, bytes);
  return dest;
}

/** Agent reply chips: Cloud API by storage path (avoids Supabase CORS in dev). */
export async function openOrDownloadAgentReplyAttachment(
  item: AgentReplyAttachment,
): Promise<AttachmentOpenResult> {
  const { bytes, contentType } = await fetchAgentReplyAttachmentBytes(item);
  const safeName = sanitizeFilename(item.filename);

  if (isTauri()) {
    const dest = await downloadBytesViaTauri(bytes, safeName);
    if (!dest) return "cancelled";
    await revealInFinder(dest);
    return "downloaded";
  }

  await downloadBytesViaBrowser(bytes, safeName, contentType);
  return "downloaded";
}

