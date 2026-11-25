import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// The app file store as the repository sees it: the operations, the scoped
// credentials an app gets for its own prefix, and the quota sweep. Vendor-
// neutral. The Alibaba implementation (STS session policy, OSS through the S3
// API) is `app-platform/aliyun/storage.ts`, reached via `resolveAppPlatform()`.
// ---------------------------------------------------------------------------

export interface AppStorageCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  /** ISO-8601, straight from STS. The app refreshes on it rather than on 403. */
  expiration: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string;
}

export class AppStorageUnavailable extends Error {}

export interface PrefixUsage {
  bytes: number;
  objects: number;
  /** True when the sweep stopped at maxPages with more keys left to count. */
  truncated: boolean;
}

/**
 * Measure one app's prefix by listing it.
 *
 * This is the whole quota mechanism, and it is deliberately a periodic sweep
 * rather than a running total: once an app holds an STS token it writes to OSS
 * without passing through us, so an incremented counter would drift and a
 * synchronous quota check would only ever see the fraction of writes that came
 * through the control plane. Enforcement therefore happens where we ARE in the
 * path - minting credentials - and this number is allowed to be stale.
 *
 * `maxPages` bounds a sweep over an app that has gone pathological; the caller
 * records `truncated` so a partial count is never mistaken for a small app.
 */
export async function measurePrefixUsage(
  s3: S3Client,
  bucket: string,
  prefix: string,
  maxPages = 50,
): Promise<PrefixUsage> {
  let bytes = 0;
  let objects = 0;
  let token: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const out: any = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const o of out.Contents ?? []) {
      bytes += Number(o.Size ?? 0);
      objects += 1;
    }
    if (!out.IsTruncated) return { bytes, objects, truncated: false };
    token = out.NextContinuationToken;
  }
  return { bytes, objects, truncated: true };
}

/** Quota verdict used by every credential-minting path. */
export function isOverQuota(
  storageBytes: number | null | undefined,
  quotaBytes: number | null | undefined,
): boolean {
  if (quotaBytes == null || quotaBytes <= 0) return false;
  if (storageBytes == null) return false;
  return storageBytes >= quotaBytes;
}

export interface AppFileEntry {
  path: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

export interface AppStorageOps {
  readonly roleArn: string;
  readonly defaultQuotaBytes: number | null;
  /** The apps profile's region and endpoint, so callers need not re-resolve them. */
  readonly region: string;
  readonly endpoint: string;
  bucketFor(app: { oss_bucket?: string | null } | null | undefined): string;
  /**
   * One page of objects under `prefix`.
   *
   * With `delimiter: "/"` the store collapses everything below the next `/`
   * into `folders` and returns only the objects sitting directly at this level
   * — which is what makes a browser a browser rather than a flat dump of every
   * key in the app. Without it the listing is fully recursive, which is what a
   * count or a sweep wants.
   */
  list(
    bucket: string,
    prefix: string,
    opts: { after?: string | null; limit?: number; delimiter?: string | null },
  ): Promise<{ items: AppFileEntry[]; folders: string[]; nextCursor: string | null }>;
  signUpload(bucket: string, key: string, contentType?: string | null): Promise<string>;
  signDownload(bucket: string, key: string, filename?: string | null): Promise<string>;
  head(bucket: string, key: string): Promise<{ size: number; contentType: string | null } | null>;
  remove(bucket: string, key: string): Promise<void>;
  removePrefix(bucket: string, prefix: string): Promise<number>;
  measure(bucket: string, prefix: string): Promise<PrefixUsage>;
  assume(app: { id: string; oss_bucket?: string | null }, durationSeconds?: number): Promise<AppStorageCredentials>;
}
