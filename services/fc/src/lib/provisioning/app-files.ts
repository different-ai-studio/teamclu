/**
 * Where an app's own files live in the object store, and the rules a path must
 * pass before it becomes a key. Vendor-neutral: any S3-compatible store uses
 * the same layout. Split out of the Aliyun OSS profile module
 * (`app-platform/aliyun/oss.ts`) so business code can name keys without
 * importing the cloud.
 */

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

// ---------------------------------------------------------------------------
// App file storage (design 2026-09-09).
//
// `app-files/` is a SEPARATE top-level prefix from `apps/`, and that separation
// is load-bearing rather than cosmetic. Deleting an app tears down the build
// artifact (`apps/<appId>/code.zip`) but KEEPS the user's files, exactly as it
// keeps the Postgres schema. Were the files a subtree of `apps/<appId>/`, the
// obvious cleanup, "drop this app's prefix", would take the user's data with
// it, and nothing in the key space would object.
// ---------------------------------------------------------------------------

/** Top-level prefix for app-owned files. Never `apps/`; see the note above. */
export const APP_FILES_PREFIX = "app-files";

/** Everything under this app's file store, with the trailing slash. */
export function appFilesPrefix(appId: string): string {
  if (!appId.trim()) throw new Error("appFilesPrefix: appId is required");
  return `${APP_FILES_PREFIX}/${appId}/`;
}

/** C0 controls plus DEL, written as escapes so the source stays printable. */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

/**
 * Reject a path before it becomes a key, in ONE place.
 *
 * The rules are about what can escape this app's prefix or confuse the store,
 * not about what looks tidy: a leading slash or a `..` segment is how a key
 * climbs out of `app-files/<appId>/`, an empty segment produces a key no client
 * can address again, and OSS caps a key at 1024 bytes, so a longer one fails at
 * PUT time, after the bytes have already been sent.
 */
export function assertSafeAppFilePath(path: string): string {
  const p = String(path ?? "");
  if (!p) throw new Error("path is required");
  if (p.startsWith("/")) throw new Error("path must be relative (no leading slash)");
  if (p.endsWith("/")) throw new Error("path must name a file, not a directory");
  if (CONTROL_CHARS.test(p)) throw new Error("path must not contain control characters");
  for (const seg of p.split("/")) {
    if (seg === "") throw new Error("path must not contain empty segments");
    if (seg === "." || seg === "..") throw new Error("path must not contain . or .. segments");
  }
  return p;
}

/**
 * Full object key for one of an app's files.
 *
 * Byte length is checked on the composed key, not on the caller's path: the
 * prefix is ~50 bytes of the 1024-byte budget and a path that fits on its own
 * can still overflow once prefixed.
 */
export function appFileKey(appId: string, path: string): string {
  const key = `${appFilesPrefix(appId)}${assertSafeAppFilePath(path)}`;
  if (Buffer.byteLength(key, "utf8") > 1024) {
    throw new Error("object key exceeds the 1024-byte limit");
  }
  return key;
}

/** The path back out of a full key, or null when the key is not this app's. */
export function appFilePathFromKey(appId: string, key: string): string | null {
  const prefix = appFilesPrefix(appId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/**
 * Which bucket holds this app's files.
 *
 * Reads the row first so a per-app bucket is a data change rather than a code
 * change (design 2.3). Every app is expected to answer with the deployment's
 * apps bucket; the column exists for the one that will not.
 */
export function appStorageBucket(
  app: { oss_bucket?: string | null; ossBucket?: string | null } | null | undefined,
  profile: { bucket: string },
): string {
  const override = (app?.oss_bucket ?? app?.ossBucket ?? "").trim();
  return override || profile.bucket;
}

/** Deployment-wide default quota; NULL on the row falls back to this. */
export function defaultStorageQuotaBytes(env: Env = process.env): number | null {
  const raw = trimmed(env.APPS_STORAGE_QUOTA_BYTES);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * A caller-supplied folder prefix, made safe to append to the app's own.
 *
 * Leading slashes go (they would produce a double separator), `..` segments go
 * (an object store has no parent traversal, but the string would still address
 * a literal ".." key nobody meant), and a non-empty prefix always ends in "/"
 * so that `logs` cannot also match `logs-archive/`.
 */
export function normalizeAppFolderPrefix(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const parts = raw
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "." && p !== "..");
  return parts.length === 0 ? "" : `${parts.join("/")}/`;
}
