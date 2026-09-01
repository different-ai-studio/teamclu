import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { createServiceRoleClient } from "./supabase.js";
import { getS3Client, OSS_BUCKET } from "./oss.js";

// ---------------------------------------------------------------------------
// Blob storage for team files.
//
// Both team sync (knowledge documents) and the skills registry store immutable,
// content-addressed, client-encrypted blobs. They share this signing layer and
// differ only in which private bucket they land in — one place to change when
// the storage backend moves again.
//
// On S3 everything shares ONE bucket (`BUCKET`) and is separated by key prefix,
// so a deployment needs exactly one bucket to provision and one policy to
// reason about:
//
//   apps/<appId>/code.zip                       app bundles (already distinct)
//   team-blobs/teams/<teamId>/blobs/sha256/...  knowledge documents
//   team-skills/teams/<teamId>/blobs/sha256/... skill packages
//
// The prefix matters for the last two: their object paths are byte-identical
// (both content-addressed the same way), so without it a skill package and a
// knowledge blob would be the same object — harmless while both exist, fatal
// the moment one side's GC deletes it out from under the other.
//
// `TEAM_BLOBS_STORAGE_BUCKET` / `SKILLS_STORAGE_BUCKET` name the Supabase
// bucket on the supabase backend and the key prefix on the s3 one. One setting,
// one meaning per backend: "where this kind of blob lives".
//
// Two backends, picked by `TEAM_BLOBS_BACKEND`:
//
//   supabase (default) — Supabase Storage, the historical home.
//   s3                 — any S3-compatible store: MinIO on self-host, Alibaba
//                        OSS on the Aliyun FC target. Same protocol both ways,
//                        which is the point: file bytes stop riding on the
//                        Postgres-adjacent stack that also serves auth and the
//                        control plane.
//
// The switch is an explicit env var rather than "S3 creds are present": the
// Aliyun target already sets `ACCESS_KEY_ID` for app-bundle uploads, and
// inferring from that would silently relocate every team's blobs the day
// someone configured app deploys.
//
// Object paths keep the historical `teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>`
// shape, and `amuxc_blobs.oss_key` keeps its name: the column is just "where the
// bytes are", and renaming it would be a large migration for zero behaviour.
// ---------------------------------------------------------------------------

/**
 * Signed URLs are minted with the service-role client, which talks to Supabase
 * over `SUPABASE_URL`. On self-host that is the in-cluster address
 * (`http://kong:8000`) — correct for FC, useless to the client the URL is
 * handed to, which cannot resolve `kong` and fails the transfer outright.
 *
 * So rewrite the origin to the publicly reachable one. The path, query and
 * token are untouched; only the host the client dials changes.
 */
function toPublicUrl(signedUrl: string): string {
  const publicBase = process.env.SUPABASE_PUBLIC_URL?.trim();
  if (!publicBase) return signedUrl;
  try {
    const target = new URL(signedUrl, process.env.SUPABASE_URL || undefined);
    const base = new URL(publicBase);
    target.protocol = base.protocol;
    // hostname + port, not `host`: the `host` setter leaves the existing port
    // in place when the value it is given has none, so kong's :8000 survived
    // onto the public hostname and the transfer still failed.
    target.hostname = base.hostname;
    target.port = base.port;
    return target.toString();
  } catch {
    return signedUrl;
  }
}

/** One finished part, as the client reports it back. */
export interface MultipartPart {
  partNumber: number;
  etag: string;
}

/**
 * Chunked upload, for backends that have it.
 *
 * The single presigned PUT the rest of this module deals in is one request for
 * the whole object: the client must hold every byte in memory to sign nothing
 * and send it once, and a connection that drops at 90% starts again at 0. This
 * splits one object across N independently-retryable PUTs.
 *
 * `minPartBytes` is not a tuning knob, it is what the store rejects below.
 * S3 refuses any part but the last under 5 MiB at CompleteMultipartUpload time
 * — `EntityTooSmall`, after every byte has already been sent — and MinIO, which
 * is what self-host runs, enforces the same floor. So the number has to travel
 * to the client: a daemon configured for 1 MiB parts must learn that it cannot
 * have them BEFORE it uploads, not from a failed complete.
 */
export interface MultipartSupport {
  /** Smallest non-final part the backend accepts. */
  minPartBytes: number;
  /** Hard ceiling on part count for one object. */
  maxParts: number;
  /** Begin an upload; returns the backend's upload id. */
  create(objectPath: string): Promise<string>;
  /** Presign the PUT for one part. The client reads the ETag off the response. */
  signPart(
    objectPath: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;
  /** Assemble the parts into the final object. */
  complete(objectPath: string, uploadId: string, parts: MultipartPart[]): Promise<void>;
  /**
   * Discard an upload and its parts. Idempotent for the same reason `remove`
   * is: the only callers are error paths, and "already gone" is the outcome
   * they wanted. Unaborted uploads keep billing for storage nobody can read.
   */
  abort(objectPath: string, uploadId: string): Promise<void>;
}

/** What sync-handlers and the skills routes need from a blob store. */
export interface BlobStorage {
  createUploadUrl(objectPath: string): Promise<string>;
  createDownloadUrl(objectPath: string, expiresIn?: number): Promise<string>;
  /** `null` when the object does not exist. */
  stat(objectPath: string): Promise<{ size: number } | null>;
  /**
   * SHA-256 hex of the object bytes. `null` when the object does not exist.
   * Used by skill-package complete to prove the uploaded zip is the claimed
   * contentHash, not merely the claimed size.
   */
  hashSha256(objectPath: string): Promise<string | null>;
  /**
   * Remove the bytes. Idempotent: an object that is already gone is a success,
   * because the only caller is a collector and "not there" is the outcome it
   * wanted. Real failures (credentials, network, bucket gone) still throw.
   */
  remove(objectPath: string): Promise<void>;
  /**
   * Chunked upload, or `undefined` on a backend without it.
   *
   * Optional rather than a throwing stub: "does this deployment do multipart"
   * is a question the sync handler has to answer before it starts, so the
   * client can be told to fall back to a single PUT rather than discovering it
   * halfway through an upload.
   */
  multipart?: MultipartSupport;
}

/**
 * S3's floor on every part but the last, and its ceiling on part count.
 *
 * Both are protocol facts rather than settings: AWS S3, MinIO and Alibaba OSS
 * all reject a short non-final part at complete time. They are exported so the
 * sync handler can hand them to the client instead of restating them.
 */
export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
export const S3_MAX_PARTS = 10_000;

export const TEAM_BLOBS_BUCKET = () => process.env.TEAM_BLOBS_STORAGE_BUCKET || "team-blobs";
export const SKILLS_BUCKET = () => process.env.SKILLS_STORAGE_BUCKET || "team-skills";

function splitPath(objectPath: string): { dir: string; name: string } {
  const slash = objectPath.lastIndexOf("/");
  return { dir: objectPath.slice(0, slash), name: objectPath.slice(slash + 1) };
}

/** A `BlobStorage` backed by one private Supabase Storage bucket. */
export function supabaseBlobStorage(bucket: () => string): BlobStorage {
  return {
    async createUploadUrl(objectPath) {
      const { data, error } = await createServiceRoleClient()
        .storage.from(bucket())
        .createSignedUploadUrl(objectPath, { upsert: true });
      if (error || !data) {
        throw new Error(
          `failed to create signed upload url: ${error?.message ?? "unknown error"}`,
        );
      }
      return toPublicUrl(data.signedUrl);
    },

    async createDownloadUrl(objectPath, expiresIn = 900) {
      const { data, error } = await createServiceRoleClient()
        .storage.from(bucket())
        .createSignedUrl(objectPath, expiresIn);
      if (error || !data) {
        throw new Error(
          `failed to create signed download url: ${error?.message ?? "unknown error"}`,
        );
      }
      return toPublicUrl(data.signedUrl);
    },

    async stat(objectPath) {
      // Supabase Storage has no HEAD; `list` scoped to the parent directory with
      // a `search` on the exact filename is the cheapest equivalent.
      const { dir, name } = splitPath(objectPath);
      const { data, error } = await createServiceRoleClient()
        .storage.from(bucket())
        .list(dir, { search: name, limit: 1 });
      if (error || !data) return null;
      const entry = data.find((f: { name: string }) => f.name === name);
      if (!entry) return null;
      return { size: (entry as { metadata?: { size?: number } }).metadata?.size ?? 0 };
    },

    async hashSha256(objectPath) {
      const { data, error } = await createServiceRoleClient()
        .storage.from(bucket())
        .download(objectPath);
      if (error || !data) return null;
      const buf = Buffer.from(await data.arrayBuffer());
      return createHash("sha256").update(buf).digest("hex");
    },

    async remove(objectPath) {
      const { error } = await createServiceRoleClient()
        .storage.from(bucket())
        .remove([objectPath]);
      // `remove` reports a missing key in `data[].error` rather than here, and
      // we do not care either way — see the interface note on idempotence.
      if (error) {
        throw new Error(`failed to delete blob: ${error.message}`);
      }
    },
  };
}

/**
 * A `BlobStorage` backed by one private S3-compatible bucket.
 *
 * Presigned URLs are handed to the daemon, which PUTs/GETs them **directly** —
 * FC never sees the bytes. So `ENDPOINT` must be the host the client can reach,
 * not an in-cluster address: SigV4 covers the Host header, so signing for
 * `minio:9000` and dialing `s3.example.com` fails the signature, and signing
 * for a host the client cannot resolve fails the transfer. This is why the
 * self-host MinIO sits behind Caddy on its own domain.
 *
 * `prefix` is what keeps the shared bucket's tenants apart; see the module
 * header. Passing an empty one is legitimate (app bundles carry their own
 * `apps/` prefix already).
 */
export function s3BlobStorage(bucket: () => string, prefix: () => string): BlobStorage {
  const key = (objectPath: string) => {
    const p = prefix().replace(/^\/+|\/+$/g, "");
    return p ? `${p}/${objectPath}` : objectPath;
  };
  return {
    async createUploadUrl(objectPath) {
      // `as any`: two @aws-sdk major versions coexist in the tree, so the
      // presigner's `Client` and this `S3Client` have separate declarations of
      // a private field. Same cast `index.ts` uses for app-bundle uploads.
      return getSignedUrl(
        getS3Client() as any,
        new PutObjectCommand({ Bucket: bucket(), Key: key(objectPath) }),
        { expiresIn: 900 },
      );
    },

    async createDownloadUrl(objectPath, expiresIn = 900) {
      return getSignedUrl(
        getS3Client() as any,
        new GetObjectCommand({ Bucket: bucket(), Key: key(objectPath) }),
        { expiresIn },
      );
    },

    async stat(objectPath) {
      try {
        const head = await getS3Client().send(
          new HeadObjectCommand({ Bucket: bucket(), Key: key(objectPath) }),
        );
        return { size: head.ContentLength ?? 0 };
      } catch (e) {
        if (isMissingObject(e)) return null;
        throw e;
      }
    },

    async hashSha256(objectPath) {
      try {
        const obj = await getS3Client().send(
          new GetObjectCommand({ Bucket: bucket(), Key: key(objectPath) }),
        );
        if (!obj.Body) return null;
        const hash = createHash("sha256");
        for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
        }
        return hash.digest("hex");
      } catch (e) {
        if (isMissingObject(e)) return null;
        throw e;
      }
    },

    async remove(objectPath) {
      try {
        await getS3Client().send(
          new DeleteObjectCommand({ Bucket: bucket(), Key: key(objectPath) }),
        );
      } catch (e) {
        // S3 answers 204 for an absent key, but MinIO and OSS are not always so
        // agreeable — swallow the same "no such object" shapes `stat` knows.
        if (isMissingObject(e)) return;
        throw e;
      }
    },

    multipart: {
      minPartBytes: S3_MIN_PART_BYTES,
      maxParts: S3_MAX_PARTS,

      async create(objectPath) {
        const out = await getS3Client().send(
          new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key(objectPath) }),
        );
        if (!out.UploadId) throw new Error("createMultipartUpload returned no UploadId");
        return out.UploadId;
      },

      async signPart(objectPath, uploadId, partNumber, expiresIn = 3600) {
        // Longer-lived than the single-PUT URL by design: a multipart upload is
        // N sequential transfers of a large object, and the last part's URL has
        // to still be valid after the first N-1 have gone up.
        return getSignedUrl(
          getS3Client() as any,
          new UploadPartCommand({
            Bucket: bucket(),
            Key: key(objectPath),
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        );
      },

      async complete(objectPath, uploadId, parts) {
        await getS3Client().send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket(),
            Key: key(objectPath),
            UploadId: uploadId,
            // S3 requires ascending part numbers; the client assembles this
            // list from concurrent uploads, so sort rather than trust order.
            MultipartUpload: {
              Parts: [...parts]
                .sort((a, b) => a.partNumber - b.partNumber)
                .map((pt) => ({ PartNumber: pt.partNumber, ETag: pt.etag })),
            },
          }),
        );
      },

      async abort(objectPath, uploadId) {
        try {
          await getS3Client().send(
            new AbortMultipartUploadCommand({
              Bucket: bucket(),
              Key: key(objectPath),
              UploadId: uploadId,
            }),
          );
        } catch (e) {
          if (isMissingObject(e)) return;
          throw e;
        }
      },
    },
  };
}

/**
 * Whether an S3 error means "no such object" rather than a real failure.
 *
 * A missing object is the normal needs-upload answer. Everything else (bad
 * creds, network, bucket gone) must propagate: treating those as "absent" would
 * report every blob as missing and re-upload the entire team.
 */
export function isMissingObject(e: unknown): boolean {
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (e as { name?: string })?.name;
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

/** Which backend `getTeamBlobStorage` / the skills store resolve to. */
export function blobBackendKind(): "s3" | "supabase" {
  return process.env.TEAM_BLOBS_BACKEND?.trim() === "s3" ? "s3" : "supabase";
}

/**
 * A blob store for one kind of blob, on whichever backend this deployment runs.
 *
 * `name` is the Supabase bucket on the supabase backend, and the key prefix
 * inside the single shared `BUCKET` on the s3 one.
 */
export function blobStorageFor(name: () => string): BlobStorage {
  return blobBackendKind() === "s3"
    ? s3BlobStorage(OSS_BUCKET, name)
    : supabaseBlobStorage(name);
}

let cachedTeamBlobStorage: BlobStorage | undefined;

/** Default blob store for team file sync. */
export function getTeamBlobStorage(): BlobStorage {
  cachedTeamBlobStorage ??= blobStorageFor(TEAM_BLOBS_BUCKET);
  return cachedTeamBlobStorage;
}
