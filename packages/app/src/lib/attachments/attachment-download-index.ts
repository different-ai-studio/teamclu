import { isTauri } from "@/lib/utils";

const STORAGE_KEY = "teamclu:attachment-download-index";

interface AttachmentDownloadEntry {
  path: string;
  filename: string;
  savedAt: number;
}

/** Stable cache key — ignores signed-URL query tokens. */
export function normalizeAttachmentUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0]?.split("#")[0] ?? url;
  }
}

function readIndex(): Record<string, AttachmentDownloadEntry> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, AttachmentDownloadEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, AttachmentDownloadEntry>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(index));
}

export function getCachedAttachmentPath(urlKey: string): string | null {
  return readIndex()[urlKey]?.path ?? null;
}

export function setCachedAttachmentPath(
  urlKey: string,
  path: string,
  filename: string,
): void {
  const index = readIndex();
  index[urlKey] = { path, filename, savedAt: Date.now() };
  writeIndex(index);
}

export function removeCachedAttachmentPath(urlKey: string): void {
  const index = readIndex();
  delete index[urlKey];
  writeIndex(index);
}

export async function attachmentPathExists(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(path);
  } catch {
    return false;
  }
}
