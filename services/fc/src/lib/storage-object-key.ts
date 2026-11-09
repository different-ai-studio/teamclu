import { ApiError } from "./http-utils.js";

/**
 * Supabase Storage 1.54.1 `isValidKey` (storage-api `limits.ts`).
 *
 * JavaScript `\w` is ASCII-only, so a key like
 * `…/AI升级能力地图方案.pdf` is rejected with HTTP 400 `InvalidKey`
 * before the object is written. Spaces and a few punctuation marks are
 * allowed by storage; we still rewrite those (see `safeObjectName`) because
 * the public URL is the raw key and the daemon already uses the stricter
 * alphabet.
 */
export const SUPABASE_STORAGE_KEY_PATTERN =
  /^(\w|\/|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

export function isSupabaseStorageKey(key: string): boolean {
  return key.length > 0 && SUPABASE_STORAGE_KEY_PATTERN.test(key);
}

/**
 * Object-key-safe form of one path segment.
 *
 * Same rules as `safe_object_name` in
 * `apps/daemon/src/channels/core/mod.rs` and
 * `apps/daemon/src/runtime/attachment_filename.rs`: the displayed filename
 * stays on the message; only the storage key is rewritten. Keep the three
 * copies in lockstep — the unit tests pin the shared cases.
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

  // Stem and extension are scrubbed apart. Trimming the joined string ate
  // the dot and turned `诗一首.md` into `md`.
  const dot = filename.lastIndexOf(".");
  const hasExt = dot >= 0 && dot < filename.length - 1;
  const stem = scrub(hasExt ? filename.slice(0, dot) : filename) || "file";
  if (!hasExt) return stem;
  const ext = scrub(filename.slice(dot + 1));
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * Rewrite every segment of a storage object path.
 *
 * Directory segments (team id, session id, attachment id) are UUIDs and pass
 * through unchanged, so the team-scoped storage RLS prefix is preserved.
 * Empty segments are dropped: a trailing slash or `//` is not a key storage
 * will keep, and `..` scrubs to `file` rather than a parent reference.
 */
export function safeStorageObjectPath(path: string): string {
  const segments = path
    .trim()
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => safeObjectName(segment));
  if (segments.length === 0) {
    throw new ApiError(400, "invalid_request", "path query parameter is required");
  }
  const safe = segments.join("/");
  if (!isSupabaseStorageKey(safe)) {
    throw new ApiError(400, "invalid_request", "attachment path is not a valid storage key");
  }
  return safe;
}

/**
 * MIME types the `attachments` bucket was created with
 * (`20260514002741_create_attachments_bucket.sql`). Storage rejects anything
 * else with `InvalidMimeType`. `application/octet-stream` is on the list, so
 * Office files (ppt/pptx/doc/xls and the OOXML equivalents) are stored as
 * that. The original filename — including its extension — stays on the
 * message, which is what the client uses for display and download.
 *
 * The `avatars` bucket has its own allowlist (jpeg/png/webp). Do not coerce
 * those uploads or a gif that storage would reject as `image/gif` becomes
 * `application/octet-stream` and fails the same way with a worse message.
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

export function storageContentTypeForBucket(
  contentType: string | null | undefined,
  bucket: string,
): string {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (bucket !== "attachments") return base || "application/octet-stream";
  if (ATTACHMENT_BUCKET_MIME_TYPES.has(base)) return base;
  return "application/octet-stream";
}

/** Percent-encode each segment so the public object URL matches the key. */
export function encodeStorageObjectKeyForUrl(objectPath: string): string {
  return objectPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
