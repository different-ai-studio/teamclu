import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  getS3Client,
  OSS_BUCKET as BUCKET,
} from "./oss.js";
import { json } from "./responses.js";

// ---------------------------------------------------------------------------
// OSS-backed JSON object store + team-registry auth helpers.
//
// Extracted from admin-handlers.ts. These wrap the team metadata / registry
// objects that live under `teams/<id>/_registry` and `teams/<id>/_meta` in the
// OSS bucket.
//
// Still Alibaba OSS, and still live: /reset-secret reads and writes
// `_registry/auth.json`. Team file sync no longer touches this bucket at all
// (see team-blob-storage.ts) — this is the last thing left on it.
//
// `ossInfo()` and `verifyTeam()` went with /register, /token and /apply.
// ---------------------------------------------------------------------------

export function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export async function ossGet(key: string) {
  const s3 = getS3Client();
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET(), Key: key })
    );
    const text = await (res.Body as { transformToString(): Promise<string> }).transformToString();
    return JSON.parse(text);
  } catch (err: any) {
    if (
      err.name === "NoSuchKey" ||
      err.$metadata?.httpStatusCode === 404 ||
      err.Code === "NoSuchKey"
    ) {
      return null;
    }
    throw err;
  }
}

export async function ossPut(key: string, data: unknown) {
  const s3 = getS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    })
  );
}

