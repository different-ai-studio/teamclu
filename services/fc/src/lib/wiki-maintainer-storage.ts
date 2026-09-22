import { ApiError } from "./http-utils.js";
import {
  getTeamBlobStorage,
  type BlobStorage,
} from "./team-blob-storage.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;

export function assertCheckpointDescriptor(input: {
  teamId: unknown;
  sha256: unknown;
  size: unknown;
}) {
  const teamId = String(input.teamId ?? "").trim();
  const sha256 = String(input.sha256 ?? "").trim();
  const size = Number(input.size);
  if (!teamId || !/^[0-9a-z-]+$/i.test(teamId)) {
    throw new ApiError(400, "validation_failed", "invalid team id");
  }
  if (!SHA256_RE.test(sha256)) {
    throw new ApiError(400, "validation_failed", "sha256 must be 64 lowercase hex characters");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CHECKPOINT_BYTES) {
    throw new ApiError(
      400,
      "validation_failed",
      `checkpoint size must be between 1 and ${MAX_CHECKPOINT_BYTES} bytes`,
    );
  }
  return { teamId, sha256, size };
}

export function checkpointObjectKey(teamId: string, sha256: string): string {
  const valid = assertCheckpointDescriptor({ teamId, sha256, size: 1 });
  return `wiki-maintainer/teams/${valid.teamId}/checkpoints/sha256/${valid.sha256.slice(0, 2)}/${valid.sha256}.zip`;
}

export async function checkpointUpload(
  descriptor: { teamId: string; sha256: string; size: number },
  storage: BlobStorage = getTeamBlobStorage(),
) {
  const valid = assertCheckpointDescriptor(descriptor);
  const objectKey = checkpointObjectKey(valid.teamId, valid.sha256);
  const current = await storage.stat(objectKey);
  let verified = false;
  if (current?.size === valid.size) {
    verified = (await storage.hashSha256(objectKey)) === valid.sha256;
  }
  return {
    objectKey,
    requiresUpload: !verified,
    presignedPut: verified
      ? null
      : await storage.createUploadUrl(objectKey, { contentLength: valid.size }),
  };
}

export async function verifyCheckpointObject(
  descriptor: {
    teamId: string;
    objectKey: string;
    sha256: string;
    size: number;
  },
  storage: BlobStorage = getTeamBlobStorage(),
): Promise<void> {
  const valid = assertCheckpointDescriptor(descriptor);
  const expectedKey = checkpointObjectKey(valid.teamId, valid.sha256);
  if (descriptor.objectKey !== expectedKey) {
    throw new ApiError(400, "validation_failed", "checkpoint object key does not match sha256");
  }
  const stat = await storage.stat(expectedKey);
  if (!stat || stat.size !== valid.size) {
    throw new ApiError(422, "blob_missing", "checkpoint upload is missing or has the wrong size");
  }
  if ((await storage.hashSha256(expectedKey)) !== valid.sha256) {
    throw new ApiError(422, "hash_mismatch", "checkpoint upload hash does not match");
  }
}

export async function checkpointDownloadUrl(
  objectKey: string,
  storage: BlobStorage = getTeamBlobStorage(),
): Promise<string> {
  if (!objectKey.startsWith("wiki-maintainer/teams/")) {
    throw new ApiError(500, "invalid_checkpoint", "checkpoint object key is invalid");
  }
  return storage.createDownloadUrl(objectKey, 900);
}
