import { S3Client } from "@aws-sdk/client-s3";
import {
  ACCESS_KEY_ID,
  ACCESS_KEY_SECRET,
  OSS_BUCKET,
  OSS_ENDPOINT,
  OSS_FORCE_PATH_STYLE,
  OSS_REGION,
} from "../oss.js";

/**
 * Where an app's built code artifact (`apps/<appId>/code.zip`) is staged, and
 * with which credentials — for BOTH the presigned upload the daemon PUTs to
 * and the OSS object Function Compute reads the code from.
 *
 * Why this is not simply the deployment's default S3 config: on self-host the
 * default one is MinIO (`ACCESS_KEY_ID`/`ACCESS_KEY_SECRET` are the MinIO root
 * credentials, `ENDPOINT` is `https://s3.<host>`, `S3_FORCE_PATH_STYLE=1`).
 * Alibaba Function Compute cannot read code out of a box-local MinIO bucket, so
 * a self-host deployment that wants app deploys needs a SECOND, real Alibaba
 * OSS profile alongside the MinIO one. On the Alibaba FC target both are the
 * same account and no new configuration is needed at all.
 */
export interface AppsOssProfile {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** Only MinIO needs path-style addressing; Alibaba OSS is virtual-host. */
  forcePathStyle: boolean;
}

export type AppsOssResolution =
  | { profile: AppsOssProfile; error?: undefined }
  | { profile?: undefined; error: string };

type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

/**
 * Region for the app's function AND its code bucket. Function Compute can only
 * load code from an OSS bucket in its OWN region, so one knob covers both — two
 * would let them drift into a deploy that fails inside the FC API.
 */
export function appsRegion(env: Env = process.env): string {
  return trimmed(env.APPS_REGION) || OSS_REGION(env);
}

/**
 * Resolve the apps artifact profile, or explain what is missing.
 *
 * Returning the reason rather than a bare null is deliberate: the failure this
 * replaces surfaced to the user as `deploy provisioning not configured`, which
 * named no variable and cost an SSH session to diagnose.
 */
export function resolveAppsOss(env: Env = process.env): AppsOssResolution {
  const dedicatedKey = trimmed(env.APPS_ACCESS_KEY_ID);

  // --- Dedicated profile: apps live in a different account than the default
  // S3 config (the self-host shape). Nothing is inherited from ENDPOINT /
  // S3_FORCE_PATH_STYLE — inheriting them is precisely how app code would get
  // presigned into MinIO with an Alibaba key and 403 on upload.
  if (dedicatedKey) {
    const secret = trimmed(env.APPS_ACCESS_KEY_SECRET);
    if (!secret) {
      return { error: "APPS_ACCESS_KEY_ID is set but APPS_ACCESS_KEY_SECRET is empty" };
    }
    const bucket = trimmed(env.APPS_OSS_BUCKET);
    if (!bucket) {
      return {
        error:
          "APPS_ACCESS_KEY_ID is set but APPS_OSS_BUCKET is empty — app code cannot fall back to BUCKET, which belongs to the default (possibly MinIO) endpoint",
      };
    }
    const region = appsRegion(env);
    return {
      profile: {
        bucket,
        region,
        endpoint: trimmed(env.APPS_OSS_ENDPOINT) || `https://oss-${region}.aliyuncs.com`,
        accessKeyId: dedicatedKey,
        accessKeySecret: secret,
        forcePathStyle: false,
      },
    };
  }

  // --- Shared profile: one account for everything (the Alibaba FC target).
  const accessKeyId = ACCESS_KEY_ID(env);
  const accessKeySecret = ACCESS_KEY_SECRET(env);
  if (!accessKeyId || !accessKeySecret) {
    return { error: "ACCESS_KEY_ID / ACCESS_KEY_SECRET are not set" };
  }
  // A bucket override alone is fine (same account, separate bucket for app
  // code); a REGION override alone is not, because ENDPOINT still points at the
  // old region and FC would be handed a cross-region code location.
  if (trimmed(env.APPS_REGION) && trimmed(env.APPS_REGION) !== OSS_REGION(env)) {
    return {
      error:
        `APPS_REGION (${trimmed(env.APPS_REGION)}) differs from REGION (${OSS_REGION(env)}) without a dedicated apps profile — also set APPS_ACCESS_KEY_ID / APPS_ACCESS_KEY_SECRET / APPS_OSS_BUCKET`,
    };
  }
  return {
    profile: {
      bucket: trimmed(env.APPS_OSS_BUCKET) || OSS_BUCKET(env),
      region: OSS_REGION(env),
      endpoint: OSS_ENDPOINT(env),
      accessKeyId,
      accessKeySecret,
      forcePathStyle: OSS_FORCE_PATH_STYLE(env),
    },
  };
}

/** S3 client for the app-artifact bucket — never the default team-blobs one. */
export function getAppsS3Client(profile: AppsOssProfile): S3Client {
  return new S3Client({
    region: profile.region,
    endpoint: profile.endpoint,
    credentials: {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.accessKeySecret,
    },
    forcePathStyle: profile.forcePathStyle,
  });
}

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
  profile: AppsOssProfile,
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
