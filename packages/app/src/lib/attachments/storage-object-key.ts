/**
 * Object-key-safe filename segment for Supabase Storage.
 *
 * Storage 1.54.1 `isValidKey` rejects non-ASCII keys (`InvalidKey`). This is
 * the same rewrite as `safeObjectName` in `services/fc/src/lib/storage-object-key.ts`
 * and `safe_object_name` in the daemon: the chat message keeps the original
 * filename; only the object key changes. The server applies it again, so an
 * older client still uploads, and a newer client still uploads against an
 * older server.
 */
export function safeObjectName(filename: string): string {
  const scrub = (part: string): string => {
    let out = "";
    let lastUnderscore = false;
    for (const c of part) {
      const ascii =
        (c >= "A" && c <= "Z") ||
        (c >= "a" && c <= "z") ||
        (c >= "0" && c <= "9") ||
        c === "_" ||
        c === "-" ||
        c === ".";
      if (ascii) {
        out += c;
        lastUnderscore = false;
      } else if (!lastUnderscore) {
        out += "_";
        lastUnderscore = true;
      }
    }
    return out.replace(/^[_.]+|[_.]+$/g, "");
  };

  const dot = filename.lastIndexOf(".");
  const hasExt = dot >= 0 && dot < filename.length - 1;
  const stem = scrub(hasExt ? filename.slice(0, dot) : filename) || "file";
  if (!hasExt) return stem;
  const ext = scrub(filename.slice(dot + 1));
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * Content-Type the `attachments` bucket will accept. Office MIME types are
 * not on the bucket allowlist; `application/octet-stream` is. Callers keep
 * the original filename for display — this only chooses the stored type.
 */
const ATTACHMENT_BUCKET_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/x-swift",
  "text/x-python",
  "text/x-javascript",
  "application/zip",
  "application/octet-stream",
]);

export function attachmentStorageContentType(contentType: string | null | undefined): string {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ATTACHMENT_BUCKET_MIME_TYPES.has(base)) return base;
  return "application/octet-stream";
}
