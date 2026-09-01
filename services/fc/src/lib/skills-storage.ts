import { ApiError } from "./http-utils.js";
import { SKILLS_BUCKET, blobStorageFor } from "./team-blob-storage.js";

// ---------------------------------------------------------------------------
// Supabase Storage helpers for team skill package blobs.
//
// Package bodies (zips) live in a private bucket on whichever blob backend the
// deployment runs (see team-blob-storage.ts), keyed by the
// same content-addressed path amuxc_blobs already tracks
// (teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>). amuxc_blobs stays the
// dedup/bookkeeping table; oss_key just holds this bucket's object path now.
//
// The signing itself lives in team-blob-storage.ts, shared with team file sync;
// this module is the skills-bucket binding plus the names its callers use.
// ---------------------------------------------------------------------------

export { SKILLS_BUCKET };

// Resolved lazily: `blobStorageFor` reads env, and a module-level call would
// freeze the choice at import time — before the process env is fully set up in
// some test and serverless entrypoints.
const storage = {
  createUploadUrl: (p: string) => blobStorageFor(SKILLS_BUCKET).createUploadUrl(p),
  createDownloadUrl: (p: string, e?: number) =>
    blobStorageFor(SKILLS_BUCKET).createDownloadUrl(p, e),
  stat: (p: string) => blobStorageFor(SKILLS_BUCKET).stat(p),
  hashSha256: (p: string) => blobStorageFor(SKILLS_BUCKET).hashSha256(p),
};

export function createSkillUploadUrl(objectPath: string): Promise<string> {
  return storage.createUploadUrl(objectPath);
}

export function statSkillObject(objectPath: string): Promise<{ size: number } | null> {
  return storage.stat(objectPath);
}

export function hashSkillObject(objectPath: string): Promise<string | null> {
  return storage.hashSha256(objectPath);
}

export function createSkillDownloadUrl(
  objectPath: string,
  expiresIn = 900,
): Promise<string> {
  return storage.createDownloadUrl(objectPath, expiresIn);
}

/**
 * Packages above this size are still size-checked on complete, but the bytes
 * are not pulled into FC to hash. Skill zips are well under this; see
 * docs/architecture/skill-publish-atomicity-and-blob-verification.md §4 / §8.
 */
export const SKILL_PACKAGE_HASH_CAP_BYTES = 16 * 1024 * 1024;

export function skillPackageBytesMatch(
  stat: { size: number } | null,
  digest: string | null,
  expected: { contentHash: string; size: number },
  hashCap = SKILL_PACKAGE_HASH_CAP_BYTES,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!stat || stat.size !== expected.size) {
    return {
      ok: false,
      code: "blob_missing",
      message: `Blob missing or size mismatch: expected ${expected.size}, got ${stat?.size ?? "none"}`,
    };
  }
  if (expected.size > hashCap) return { ok: true };
  const want = expected.contentHash.toLowerCase();
  if (!digest || digest !== want) {
    return {
      ok: false,
      code: "blob_hash_mismatch",
      message: `Blob hash mismatch: expected ${want}, got ${digest ?? "none"}`,
    };
  }
  return { ok: true };
}

/** HEAD/list for size, then hash bytes when the package is within the cap. */
export async function verifySkillPackageObject(
  objectPath: string,
  expected: { contentHash: string; size: number },
): Promise<void> {
  const stat = await statSkillObject(objectPath);
  const digest =
    stat && expected.size <= SKILL_PACKAGE_HASH_CAP_BYTES
      ? await hashSkillObject(objectPath)
      : null;
  const result = skillPackageBytesMatch(stat, digest, expected);
  if (result.ok === false) {
    throw new ApiError(422, result.code, result.message);
  }
}
