import i18n from "@/lib/i18n";
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

