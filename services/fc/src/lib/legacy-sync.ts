import { authenticateSyncCall } from './sync-auth.js';
import { logSyncEvent } from './sync-log.js';
import {
  handleSyncManifest,
  handleSyncUploadPrepare,
  handleSyncUploadComplete,
  handleSyncDownload,
  handleSyncDelete,
  handleSyncVersions,
  handleSyncUploadPrepareBatch,
  handleSyncUploadCompleteBatch,
  handleSyncDownloadBatch,
  handleSyncDeleteBatch,
} from './sync-handlers.js';
import { json } from './admin-handlers.js';

interface SyncRequest {
  path: string;
  httpMethod: string;
  headers: Record<string, string> | undefined;
  body: any;
}

/**
 * Handle the /sync/* dispatch block from the FC handler.
 * Contains the exact logic of the original inline switch in handler().
 */
export async function handleSyncRequest({ path, httpMethod, headers, body }: SyncRequest): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  // `/sync/set-mode` and `/sync/team-mode` are gone. There is no share-mode
  // switch any more (see CLAUDE.md, "Team Collaboration"): set-mode called an
  // RPC that rejects every service-role caller, so it could only answer 403,
  // and the last client that read team-mode was removed in #1067.
  // Every /sync/* route requires teamId + full sync auth
  const teamId = body.teamId || body.team_id;
  if (!teamId) return json(400, { error: "teamId is required" });

  const auth = await authenticateSyncCall({ headers, teamId });
  if (!auth.ok) { const a = auth as any; return json(a.status, { error: a.error }); }

  const startedAt = Date.now();
  let result: any, errorCode: string | undefined;
  try {
    switch (path) {
      case "/sync/manifest":
        result = await handleSyncManifest(auth, body);
        break;
      case "/sync/upload/prepare":
        result = await handleSyncUploadPrepare(auth, body);
        break;
      case "/sync/upload/complete":
        result = await handleSyncUploadComplete(auth, body);
        break;
      case "/sync/download":
        result = await handleSyncDownload(auth, body);
        break;
      case "/sync/delete":
        result = await handleSyncDelete(auth, body);
        break;
      case "/sync/versions":
        result = await handleSyncVersions(auth, body);
        break;
      // Batch endpoints — fan-out over the single-item handlers (whole request
      // is always 200; per-item status lives inside results[]).
      case "/sync/upload/prepare-batch":
        result = await handleSyncUploadPrepareBatch(auth, body);
        break;
      case "/sync/upload/complete-batch":
        result = await handleSyncUploadCompleteBatch(auth, body);
        break;
      case "/sync/download-batch":
        result = await handleSyncDownloadBatch(auth, body);
        break;
      case "/sync/delete-batch":
        result = await handleSyncDeleteBatch(auth, body);
        break;
      default:
        result = json(404, { error: "Not found" });
    }
  } catch (e: any) {
    errorCode = e.code || 'unhandled';
    throw e;
  } finally {
    // Parse body to extract actorId for observability, then strip __actorId.
    let parsedBody: any = null;
    let actorId: string | undefined;
    try {
      parsedBody = result && typeof result.body === 'string' ? JSON.parse(result.body) : (result?.body ?? null);
      actorId = parsedBody?.__actorId;
      if (parsedBody && '__actorId' in parsedBody) {
        delete parsedBody.__actorId;
        if (result) result = { ...result, body: JSON.stringify(parsedBody) };
      }
    } catch { /* ignore parse errors */ }
    logSyncEvent({
      endpoint: path,
      teamId: body?.teamId,
      actorId,
      latencyMs: Date.now() - startedAt,
      result: result?.statusCode ?? (errorCode ? 'error' : 'ok'),
      changeSeq: parsedBody?.changeSeq,
      contentHash: body?.contentHash,
      sizeBytes: body?.size,
      errorCode,
    });
  }
  return result;
}
