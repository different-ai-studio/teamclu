import { ApiError } from "./http-utils.js";
import { getTeamBlobStorage } from "./team-blob-storage.js";

// ---------------------------------------------------------------------------
// Turn execution traces (#1455 §7.2).
//
// The daemon uploads one gzipped JSONL blob per turn and FC keeps the pointer
// in the turn-final reply's `metadata.trace`:
//
//   prepare   authorize the caller as the reply's author, presign a PUT whose
//             signature binds the claimed byte length
//   (PUT)     daemon → storage directly
//   complete  confirm the stored size matches the claim, write the pointer
//   GET       participants read the pointer and get a presigned download plus
//             the sha256 to check it against
//
// Only the agent that wrote the reply can prepare or complete, and an uploaded
// trace cannot be prepared again, so a session participant cannot swap in a
// fabricated execution record.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Largest compressed trace FC will sign for. The daemon caps a trace at about
 * 9 MiB uncompressed (apps/daemon/src/runtime/turn_trace.rs), so a real one
 * lands far below this; the ceiling only bounds what one presigned URL can put.
 */
export const TURN_TRACE_MAX_BYTES = 16 * 1024 * 1024;

const TRACE_URL_EXPIRES_IN = 900;

export type TurnTraceStatus = "uploaded" | "failed";

/** What `messages.metadata.trace` holds. */
export interface TurnTracePointer {
  key: string;
  size: number;
  sha256: string;
  status: TurnTraceStatus;
}

export interface TurnTraceTarget {
  teamId: string;
  sessionId: string;
  turnId: string;
}

export interface TurnTraceClaim extends TurnTraceTarget {
  messageId: string;
  size: number;
  sha256: string;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ApiError(400, "validation_failed", `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

/**
 * Object path inside the team blob store. Every segment must be a UUID: these
 * come off the URL and the request body, and the key they build shares a bucket
 * with app bundles and knowledge blobs, so nothing but a UUID gets to shape it.
 */
export function turnTraceObjectKey(teamId: string, sessionId: string, turnId: string): string {
  const team = requireUuid(teamId, "teamId");
  const session = requireUuid(sessionId, "sessionId");
  const turn = requireUuid(turnId, "turnId");
  return `turns/${team}/${session}/${turn}.jsonl.gz`;
}

export function parseTurnTraceTarget(sessionId: unknown, turnId: unknown, teamId: unknown): TurnTraceTarget {
  return {
    teamId: requireUuid(teamId, "teamId"),
    sessionId: requireUuid(sessionId, "sessionId"),
    turnId: requireUuid(turnId, "turnId"),
  };
}

export function parseTurnTraceClaim(target: TurnTraceTarget, body: Record<string, unknown>): TurnTraceClaim {
  const { size, sha256 } = body;
  if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > TURN_TRACE_MAX_BYTES) {
    throw new ApiError(
      400,
      "validation_failed",
      `size must be an integer between 1 and ${TURN_TRACE_MAX_BYTES}`,
    );
  }
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    throw new ApiError(400, "validation_failed", "sha256 must be 64 lowercase hex characters");
  }
  return {
    ...target,
    messageId: requireUuid(body.messageId, "messageId"),
    size: size as number,
    sha256,
  };
}

export async function prepareTurnTraceUpload(
  repository,
  claim: TurnTraceClaim,
): Promise<{ ossKey: string; presignedPut: string; expiresIn: number }> {
  const ossKey = turnTraceObjectKey(claim.teamId, claim.sessionId, claim.turnId);
  const current = await repository.authorizeTurnTraceUpload(claim);
  if (current?.status === "uploaded") {
    throw new ApiError(409, "conflict", "turn trace already uploaded");
  }
  const presignedPut = await getTeamBlobStorage().createUploadUrl(ossKey, {
    contentLength: claim.size,
  });
  return { ossKey, presignedPut, expiresIn: TRACE_URL_EXPIRES_IN };
}

/**
 * Record the upload's outcome on the message. An `uploaded` claim is checked
 * against storage first: the signature binds the length on S3, but not on the
 * Supabase backend, so the size is confirmed here for both.
 */
export async function completeTurnTraceUpload(
  repository,
  claim: TurnTraceClaim,
  status: unknown,
): Promise<{ trace: TurnTracePointer }> {
  if (status !== "uploaded" && status !== "failed") {
    throw new ApiError(400, "validation_failed", "status must be uploaded or failed");
  }
  const key = turnTraceObjectKey(claim.teamId, claim.sessionId, claim.turnId);
  const trace: TurnTracePointer = { key, size: claim.size, sha256: claim.sha256, status };
  if (status === "uploaded") {
    const storage = getTeamBlobStorage();
    const stored = await storage.stat(key);
    if (!stored) {
      // Authorize before answering, so a non-author learns nothing about keys.
      await repository.authorizeTurnTraceUpload(claim);
      throw new ApiError(422, "blob_missing", "turn trace must be uploaded before complete");
    }
    if (stored.size !== claim.size) {
      // Recording authorizes; only the author gets to have the object removed.
      await repository.recordTurnTrace(claim, { ...trace, status: "failed" });
      await storage.remove(key);
      throw new ApiError(
        422,
        "size_mismatch",
        `stored turn trace is ${stored.size} bytes, claimed ${claim.size}`,
      );
    }
  }
  return { trace: await repository.recordTurnTrace(claim, trace) };
}

/**
 * Presign a GET for an uploaded turn trace. `null` when there is no uploaded
 * trace for the turn — never ran, still pending, or failed — or the caller
 * cannot see the session.
 */
export async function createTurnTraceDownload(
  repository,
  target: TurnTraceTarget,
): Promise<{
  ossKey: string;
  downloadUrl: string;
  expiresIn: number;
  size: number;
  sha256: string;
} | null> {
  const ossKey = turnTraceObjectKey(target.teamId, target.sessionId, target.turnId);
  const trace: TurnTracePointer | null = await repository.getTurnTrace(target);
  if (trace?.status !== "uploaded") return null;
  const downloadUrl = await getTeamBlobStorage().createDownloadUrl(ossKey, TRACE_URL_EXPIRES_IN);
  return {
    ossKey,
    downloadUrl,
    expiresIn: TRACE_URL_EXPIRES_IN,
    size: trace.size,
    sha256: trace.sha256,
  };
}
