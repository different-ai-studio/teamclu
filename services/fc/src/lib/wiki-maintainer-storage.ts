import { ApiError } from "./http-utils.js";
import { createHash } from "node:crypto";
import {
  getTeamBlobStorage,
  type BlobStorage,
} from "./team-blob-storage.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_ENTRIES = [
  "manifest.json",
  "config.json",
  "state.json",
  "wiki.bundle",
  "prepared-run.json",
] as const;

function checkpointManifest(bytes: Buffer): Record<string, unknown> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let cursor = bytes.length - 22; cursor >= 0; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50) {
      eocd = cursor;
      break;
    }
  }
  if (eocd < 0) {
    throw new ApiError(422, "invalid_checkpoint", "checkpoint is not a zip archive");
  }
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new ApiError(422, "invalid_checkpoint", "checkpoint central directory is invalid");
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw new ApiError(422, "invalid_checkpoint", "checkpoint local entry is invalid");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString("utf8");
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      name !== localName ||
      dataEnd > bytes.length ||
      method !== 0 ||
      compressedSize !== size
    ) {
      throw new ApiError(422, "invalid_checkpoint", "checkpoint entries must be stored");
    }
    if (files.has(name)) {
      throw new ApiError(422, "invalid_checkpoint", "checkpoint contains duplicate entries");
    }
    files.set(name, bytes.subarray(dataStart, dataEnd));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (
    offset !== eocd ||
    files.size !== CHECKPOINT_ENTRIES.length ||
    CHECKPOINT_ENTRIES.some((name) => !files.has(name))
  ) {
    throw new ApiError(422, "invalid_checkpoint", "checkpoint contains unexpected entries");
  }
  let manifest: any;
  try {
    manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    JSON.parse(files.get("config.json")!.toString("utf8"));
    JSON.parse(files.get("state.json")!.toString("utf8"));
    JSON.parse(files.get("prepared-run.json")!.toString("utf8"));
  } catch {
    throw new ApiError(422, "invalid_checkpoint", "checkpoint JSON is invalid");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ApiError(422, "invalid_checkpoint", "checkpoint manifest is invalid");
  }
  for (const name of CHECKPOINT_ENTRIES.filter((entry) => entry !== "manifest.json")) {
    const file = files.get(name)!;
    const descriptor = manifest.entries?.[name];
    const digest = createHash("sha256").update(file).digest("hex");
    if (descriptor?.size !== file.length || descriptor?.sha256 !== digest) {
      throw new ApiError(422, "invalid_checkpoint", `checkpoint ${name} hash does not match`);
    }
  }
  const bundle = files.get("wiki.bundle")!;
  if (!bundle.subarray(0, 16).toString("utf8").startsWith("# v2 git bundle")) {
    throw new ApiError(422, "invalid_checkpoint", "checkpoint Git bundle is invalid");
  }
  return manifest;
}

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

export function retainedCheckpointGenerations(
  rows: { generation: number; baseline: boolean }[],
): number[] {
  const baselines = rows
    .filter((row) => row.baseline)
    .map((row) => row.generation)
    .sort((left, right) => right - left)
    .slice(0, 3);
  const latestBaseline = baselines[0] ?? 0;
  const kept = new Set(baselines);
  return rows
    .filter((row) => kept.has(row.generation) || row.generation > latestBaseline)
    .map((row) => row.generation);
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
): Promise<Record<string, unknown>> {
  const valid = assertCheckpointDescriptor(descriptor);
  const expectedKey = checkpointObjectKey(valid.teamId, valid.sha256);
  if (descriptor.objectKey !== expectedKey) {
    throw new ApiError(400, "validation_failed", "checkpoint object key does not match sha256");
  }
  const stat = await storage.stat(expectedKey);
  if (!stat || stat.size !== valid.size) {
    throw new ApiError(422, "blob_missing", "checkpoint upload is missing or has the wrong size");
  }
  const bytes = await storage.readBytes(expectedKey);
  if (!bytes || bytes.length !== valid.size) {
    throw new ApiError(422, "blob_missing", "checkpoint upload is missing or has the wrong size");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== valid.sha256) {
    throw new ApiError(422, "hash_mismatch", "checkpoint upload hash does not match");
  }
  return checkpointManifest(bytes);
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
