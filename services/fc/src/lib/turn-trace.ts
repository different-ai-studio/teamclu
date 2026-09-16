import { getTeamBlobStorage } from "./team-blob-storage.js";

/** Object path inside the team blob store (see #1455 §7.2). */
export function turnTraceObjectKey(
  teamId: string,
  sessionId: string,
  turnId: string,
): string {
  const team = teamId.trim();
  const session = sessionId.trim();
  const turn = turnId.trim();
  if (!team || !session || !turn) {
    throw new Error("teamId, sessionId, and turnId are required");
  }
  return `turns/${team}/${session}/${turn}.jsonl.gz`;
}

export async function prepareTurnTraceUpload(
  teamId: string,
  sessionId: string,
  turnId: string,
): Promise<{ ossKey: string; presignedPut: string; expiresIn: number }> {
  const ossKey = turnTraceObjectKey(teamId, sessionId, turnId);
  const presignedPut = await getTeamBlobStorage().createUploadUrl(ossKey);
  return { ossKey, presignedPut, expiresIn: 900 };
}
