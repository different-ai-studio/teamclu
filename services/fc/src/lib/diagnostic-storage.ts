import { randomUUID, createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Client } from "./oss.js";
import { isMissingObject } from "./team-blob-storage.js";
import { ApiError } from "./http-utils.js";

export const MAX_DIAGNOSTIC_BYTES = 10 * 1024 * 1024;
export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_SECONDS = 15 * 60;
const RECEIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFIX = "diagnostics/";

type Metadata = Record<string, string>;
export type DiagnosticStorage = {
  put(key: string, bytes: Buffer, metadata: Metadata): Promise<void>;
  head(key: string): Promise<Metadata | null>;
  signDownload(key: string, seconds: number): Promise<string>;
};

/** Explicit opt-in: this MUST be a private bucket, never the public app artifact bucket. */
export function diagnosticStorage(): DiagnosticStorage {
  const bucket = process.env.DIAGNOSTICS_STORAGE_BUCKET?.trim();
  if (!bucket) throw new ApiError(503, "diagnostics_unavailable", "Diagnostic uploads are not configured. Please export the ZIP locally.");
  const s3 = getS3Client();
  return {
    async put(Key, Body, Metadata) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key, Body, Metadata, ContentType: "application/zip",
        ContentDisposition: 'attachment; filename="teamclu-diagnostic.zip"',
        CacheControl: "no-store",
      }));
    },
    async head(Key) {
      try {
        return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }))).Metadata ?? {};
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
    // Match existing OSS signers: the lockfile has separate private Smithy
    // handler types in client-s3 and the presigner, but they interoperate at runtime.
    signDownload: (Key, seconds) => getSignedUrl(s3 as any, new GetObjectCommand({
      Bucket: bucket, Key, ResponseCacheControl: "no-store",
      ResponseContentDisposition: 'attachment; filename="teamclu-diagnostic.zip"',
    }), { expiresIn: seconds }),
  };
}

export async function uploadDiagnostic(
  userId: string, bytes: Buffer, contentType: string | undefined,
  storage: DiagnosticStorage = diagnosticStorage(), now = Date.now(),
) {
  if (contentType?.split(";")[0].trim().toLowerCase() !== "application/zip") {
    throw new ApiError(415, "invalid_diagnostic", "Content-Type must be application/zip");
  }
  if (!bytes?.length || bytes.length > MAX_DIAGNOSTIC_BYTES) {
    throw new ApiError(413, "payload_too_large", "Diagnostic ZIP must be between 1 byte and 10 MiB");
  }
  // Reject obvious non-ZIP input. Never extract user archives on the API server.
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50 || !bytes.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) {
    throw new ApiError(422, "invalid_diagnostic", "The diagnostic package is not a ZIP archive");
  }
  const receiptId = randomUUID();
  const expiresAt = new Date(now + DIAGNOSTIC_RETENTION_MS).toISOString();
  await storage.put(`${PREFIX}${receiptId}.zip`, bytes, {
    "owner-id": userId, "created-at": new Date(now).toISOString(),
    "expires-at": expiresAt, "size-bytes": String(bytes.length),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { receiptId, expiresAt };
}

export async function downloadDiagnostic(
  receiptId: string, caller: { userId: string; operator: boolean },
  storage: DiagnosticStorage = diagnosticStorage(), now = Date.now(),
) {
  if (!RECEIPT.test(receiptId)) throw new ApiError(400, "invalid_receipt", "Invalid diagnostic receipt");
  const key = `${PREFIX}${receiptId}.zip`;
  const metadata = await storage.head(key);
  // Uniform response: a receipt alone is not a download capability or an existence oracle.
  if (!metadata || (metadata["owner-id"] !== caller.userId && caller.operator !== true)) {
    throw new ApiError(404, "not_found", "Diagnostic receipt not found");
  }
  const remaining = Math.floor((Date.parse(metadata["expires-at"]) - now) / 1000);
  if (!Number.isFinite(remaining) || remaining < 1) {
    throw new ApiError(410, "diagnostic_expired", "Diagnostic receipt has expired");
  }
  const seconds = Math.min(DOWNLOAD_SECONDS, remaining);
  return {
    receiptId, downloadUrl: await storage.signDownload(key, seconds),
    downloadExpiresAt: new Date(now + seconds * 1000).toISOString(),
    expiresAt: metadata["expires-at"],
  };
}
