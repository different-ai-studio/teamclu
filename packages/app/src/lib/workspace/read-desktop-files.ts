import { exceedsNonImageLimitBySize } from "@/lib/attachments/attachment-constants";
import type { LocalPathAttachment } from "@/lib/attachments/composer-attachment";

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "txt":
    case "md":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

interface ReadDesktopFilesResult {
  files: File[];
  /** Non-image files over 20MB. Bytes stay on disk; only the path is kept. */
  local: LocalPathAttachment[];
  /** Filenames that could not be read. */
  failed: string[];
}

/** Read absolute filesystem paths (Tauri desktop) into File objects. */
export async function readDesktopPathsAsFiles(
  paths: string[],
): Promise<ReadDesktopFilesResult> {
  const { readFile, stat } = await import("@tauri-apps/plugin-fs");
  const files: File[] = [];
  const local: LocalPathAttachment[] = [];
  const failed: string[] = [];

  for (const path of paths) {
    const name = path.split(/[/\\]/).pop() ?? "attachment";
    try {
      const info = await stat(path);
      if (exceedsNonImageLimitBySize(name, info.size)) {
        local.push({ name, size: info.size, path });
        continue;
      }
      const bytes = await readFile(path);
      const ext = name.includes(".") ? name.split(".").pop() ?? "" : "";
      const file = new File([bytes], name, { type: mimeFromExt(ext) });
      files.push(file);
    } catch (error) {
      console.error("[readDesktopPathsAsFiles] failed:", path, error);
      failed.push(name);
    }
  }

  return { files, local, failed };
}
