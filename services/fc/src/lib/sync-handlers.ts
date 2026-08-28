// services/fc/src/lib/sync-handlers.ts
//
// FC /sync/* endpoint handlers — OSS Sync v3 (spec §3).
// Each export is a standalone async function; the router in index.mjs
// dispatches here after JWT/actor auth.
//
// DUAL PATH: each handler branches on resolveBackendKind() — keep postgres AND
// supabase blocks in sync when changing OSS sync metadata (README § Dual backend).
//   postgres → makeOssSyncRepo(getDb())
//   supabase → createServiceRoleClient() + .from() / .rpc()  (production default)
// Blob bytes live in Supabase Storage under both (see team-blob-storage.ts).

import { createHash, randomUUID } from 'node:crypto';
import { createServiceRoleClient } from './supabase.js';
import { validateSyncPath } from './sync-path.js';
import { isOverByteQuota, isOverFileQuota, isRejectedSyncPath, liveByteSum, liveFileCount, maxBytesPerTeam, maxFilesPerTeam } from './sync-guards.js';
import { resolveBackendKind } from './backend-kind.js';
import { getTeamBlobStorage, type BlobStorage } from './team-blob-storage.js';
import { makeOssSyncRepo, type OssSyncRepo } from './pg-repo/oss-sync.js';
import { resolveActorForTeam } from './pg-repo/authz.js';
import { getDb, type Db } from '../db/client.js';
import { ApiError } from './http-utils.js';
import { teamWorkspaceConfig, amuxcUploadSessions } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { syncTopic } from './mqtt-topics.js';
import { pgPushDeps, pushDeps } from './push-deps.js';

const DOWNLOAD_TTL_SEC = 900;

/** Best-effort MQTT publish budget for sync hints — never blocks the HTTP 200. */
const SYNC_HINT_PUBLISH_TIMEOUT_MS = 500;

// ---------------------------------------------------------------------------
// Injectable deps — production callers omit these; tests inject stubs.
// ---------------------------------------------------------------------------

/** Minimal publisher surface (matches createMqttPublisher / push-deps). */
export interface SyncMqttPublisher {
  publish(
    topic: string,
    payload: string,
    options?: { qos?: number; retain?: boolean },
  ): Promise<void>;
}

export interface SyncHandlerDeps {
  db?: Db;
  repo?: OssSyncRepo;
  storage?: BlobStorage;
  /** Override the live-file count. Tests only — production reads the table. */
  countLiveFiles?: (teamId: string) => Promise<number | null>;
  /** Override the live-file byte sum. Tests only — production reads the table. */
  sumLiveBytes?: (teamId: string) => Promise<number | null>;
  /**
   * MQTT publisher for knowledge sync hints. `undefined` → resolve from
   * push-deps (null when MQTT_BROKER_URL is unset). Explicit `null` skips.
   */
  mqtt?: SyncMqttPublisher | null;
  /** Clock override for hint `at` (tests). */
  now?: () => Date;
  /**
   * When true, skip the per-call hint — batch wrappers publish once after
   * all items finish.
   */
  suppressSyncHint?: boolean;
  /**
   * When true, skip the byte-quota check inside single prepare — batch
   * already applied a running total across items.
   */
  skipByteQuota?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function ossKeyForHash(teamId: string, hash: string) {
  // "teams/{teamId}/blobs/sha256/<2chars>/<2chars>/<hash>"
  return `teams/${teamId}/blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

function resolveStorage(deps: SyncHandlerDeps): BlobStorage {
  return deps.storage ?? getTeamBlobStorage();
}

/**
 * Whether the client still has to upload the bytes for this content hash.
 *
 * The `amuxc_blobs` row is authoritative: `verified` means some completed
 * upload was size-checked against storage for this exact hash, and the hash IS
 * the content. Only an unverified (or absent) row costs a storage round-trip.
 *
 * That ordering matters here in a way it doesn't for skills: a prepare runs per
 * changed file per sync tick, an order of magnitude more often than a skill
 * install, and Supabase Storage has no HEAD — the fallback is a `list` call.
 */
/**
 * Live (non-deleted) file rows for a team, or `null` when it cannot be counted.
 *
 * `head: true` makes this a COUNT with no row transfer, and `liveFileCount`
 * caches the answer so a 200-item batch pays for it once.
 */
async function countLiveFiles(
  teamId: string,
  deps: SyncHandlerDeps = {},
): Promise<number | null> {
  if (deps.countLiveFiles) return deps.countLiveFiles(teamId);
  const supabase = createServiceRoleClient();
  const { count, error } = await supabase
    .from('amuxc_files')
    .select('id', { count: 'exact', head: true })
    .eq('team_id', teamId)
    .eq('deleted', false);
  if (error) return null;
  return typeof count === 'number' ? count : null;
}

/**
 * Sum of live (non-deleted) file sizes for a team, or `null` when unknown.
 *
 * Postgres: drizzle `sum(size)`. Supabase: RPC `amux.amuxc_team_live_bytes`.
 */
async function sumLiveBytes(
  teamId: string,
  deps: SyncHandlerDeps = {},
): Promise<number | null> {
  if (deps.sumLiveBytes) return deps.sumLiveBytes(teamId);
  if (resolveBackendKind() === 'postgres') {
    try {
      return await resolveRepo(deps).sumLiveBytes(teamId);
    } catch {
      return null;
    }
  }
  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .schema('amux')
      .rpc('amuxc_team_live_bytes', { p_team_id: teamId });
    if (error) return null;
    const n = typeof data === 'number' ? data : Number(data);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function blobRequiresUpload(
  storage: BlobStorage,
  ossKey: string,
  size: number,
  verified: boolean,
): Promise<boolean> {
  if (verified) return false;
  try {
    const stat = await storage.stat(ossKey);
    return !stat || stat.size !== size;
  } catch (e: any) {
    console.error('[sync/prepare] blob stat failed:', e?.message ?? e);
    return true;
  }
}

function resolveRepo(deps: SyncHandlerDeps): OssSyncRepo {
  if (deps.repo) return deps.repo;
  const db = deps.db ?? getDb();
  return makeOssSyncRepo(db);
}

/** Resolved once per process: `undefined` = not tried yet, `null` = unavailable. */
let cachedSyncMqtt: SyncMqttPublisher | null | undefined;

function resolveMqtt(deps: SyncHandlerDeps): SyncMqttPublisher | null {
  if (deps.mqtt !== undefined) return deps.mqtt;
  if (cachedSyncMqtt !== undefined) return cachedSyncMqtt;
  try {
    const bundle = resolveBackendKind() === 'postgres' ? pgPushDeps() : pushDeps();
    cachedSyncMqtt = bundle.mqtt ?? null;
  } catch (e: any) {
    // Memoize the failure too. The push bundle also builds a service-role
    // Supabase client and an APNS client, neither of which sync needs; on a
    // deployment that has no SUPABASE_SERVICE_ROLE_KEY it throws on EVERY
    // complete/delete, so this used to repeat that construction and log a line
    // per request, forever, without ever converging. Hints are best-effort —
    // the 300s timer is the fallback — so one warning is the right volume.
    console.warn('[sync] mqtt unavailable, knowledge hints disabled:', e?.message ?? e);
    cachedSyncMqtt = null;
  }
  return cachedSyncMqtt;
}

/** Test seam: forget the memoized publisher. */
export function resetSyncMqttCacheForTests(): void {
  cachedSyncMqtt = undefined;
}

function originNodeIdFromBody(body: Record<string, unknown> | undefined): string | null {
  const raw = body?.nodeId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Best-effort knowledge sync hint: one MQTT message with the highest changeSeq
 * among successful items. Never throws; 500ms timeout; missing broker is a no-op.
 */
async function publishKnowledgeSyncHint(opts: {
  teamId: string;
  changeSeq: number;
  originNodeId: string | null;
  deps: SyncHandlerDeps;
}): Promise<void> {
  const { teamId, changeSeq, originNodeId, deps } = opts;
  if (deps.suppressSyncHint) return;
  if (!Number.isFinite(changeSeq) || changeSeq <= 0) return;

  const mqtt = resolveMqtt(deps);
  if (!mqtt) return;

  const now = deps.now ?? (() => new Date());
  const topic = syncTopic(teamId, 'knowledge');
  const payload = JSON.stringify({
    v: 1,
    changeSeq,
    originNodeId,
    at: now().toISOString(),
  });

  try {
    await Promise.race([
      mqtt.publish(topic, payload, { qos: 1, retain: false }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`mqtt publish timeout after ${SYNC_HINT_PUBLISH_TIMEOUT_MS}ms`)),
          SYNC_HINT_PUBLISH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (e: any) {
    console.warn('[sync] knowledge hint publish failed:', e?.message ?? e);
  }
}

/** Max changeSeq among successful batch results; null if none succeeded. */
function maxSuccessfulChangeSeq(envelope: SyncEnvelope): number | null {
  if (envelope.statusCode < 200 || envelope.statusCode >= 300) return null;
  let parsed: { results?: unknown };
  try {
    parsed = envelope.body ? JSON.parse(envelope.body) : {};
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.results)) return null;
  let max: number | null = null;
  for (const item of parsed.results) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.ok !== true) continue;
    const seq = row.changeSeq;
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      max = max === null ? seq : Math.max(max, seq);
    }
  }
  return max;
}

async function publishHintAfterBatch(
  caller: { teamId: string },
  body: Record<string, unknown> | undefined,
  envelope: SyncEnvelope,
  deps: SyncHandlerDeps,
): Promise<void> {
  const changeSeq = maxSuccessfulChangeSeq(envelope);
  if (changeSeq === null) return;
  await publishKnowledgeSyncHint({
    teamId: caller.teamId,
    changeSeq,
    originNodeId: originNodeIdFromBody(body),
    deps: { ...deps, suppressSyncHint: false },
  });
}

async function publishHintAfterSingle(
  caller: { teamId: string },
  body: Record<string, unknown> | undefined,
  envelope: SyncEnvelope,
  deps: SyncHandlerDeps,
): Promise<SyncEnvelope> {
  if (deps.suppressSyncHint) return envelope;
  if (envelope.statusCode < 200 || envelope.statusCode >= 300) return envelope;
  let changeSeq: number | undefined;
  try {
    const parsed = envelope.body ? JSON.parse(envelope.body) : {};
    if (typeof parsed.changeSeq === 'number') changeSeq = parsed.changeSeq;
  } catch {
    return envelope;
  }
  if (changeSeq === undefined) return envelope;
  await publishKnowledgeSyncHint({
    teamId: caller.teamId,
    changeSeq,
    originNodeId: originNodeIdFromBody(body),
    deps,
  });
  return envelope;
}

// ---------------------------------------------------------------------------
// Batch fan-out (§ batch endpoints)
//
// The batch endpoints (`/sync/upload/prepare-batch`, `…/complete-batch`,
// `/sync/download-batch`, `/sync/delete-batch`) are thin fan-outs over the
// single-item handlers: same auth, same per-item logic, same backends. This
// guarantees single/batch parity — batch literally invokes the single handler.
//
// Iron rule: NO whole-batch transaction. Each item runs its own atomic op and
// produces an independent per-item result. The whole HTTP response is always
// 200; per-item status lives inside each `results[i]`. One item's conflict
// never rolls back its siblings.
// ---------------------------------------------------------------------------

/** Defensive server-side cap. The daemon pre-splits larger sets into chunks. */
export const MAX_SYNC_BATCH = 200;

type SyncEnvelope = { statusCode: number; headers: Record<string, string>; body: string };

/**
 * Run `perItem` over `items`, collecting one independent result per item.
 *
 * Each `results[i]` is `{ ok: true, ...payload }` on 2xx, otherwise
 * `{ ok: false, status, ...errorBody }`. A thrown item becomes
 * `{ ok: false, status: 500, error }` — it never aborts the rest.
 */
async function runSyncBatch(
  items: unknown,
  perItem: (item: Record<string, unknown>) => Promise<SyncEnvelope>,
) {
  if (!Array.isArray(items)) {
    return json(400, { error: 'items must be an array' });
  }
  if (items.length > MAX_SYNC_BATCH) {
    return json(400, {
      error: `batch too large: ${items.length} > ${MAX_SYNC_BATCH}`,
      code: 'batch_too_large',
    });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const item of items) {
    try {
      const env = await perItem((item ?? {}) as Record<string, unknown>);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = env.body ? JSON.parse(env.body) : {};
      } catch {
        parsed = {};
      }
      if (env.statusCode >= 200 && env.statusCode < 300) {
        results.push({ ok: true, ...parsed });
      } else {
        results.push({ ok: false, status: env.statusCode, ...parsed });
      }
    } catch (e: any) {
      results.push({ ok: false, status: 500, error: e?.message ?? 'batch item failed' });
    }
  }

  return json(200, { results });
}

// ---------------------------------------------------------------------------
// §3.1  POST /sync/manifest
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, afterSeq, limit?, cursor?, snapshotSeq? }
 */
export async function handleSyncManifest(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { afterSeq = 0, limit = 200, cursor = null, snapshotSeq: clientSnapshotSeq } = body || {};
  const teamId = caller.teamId;

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const repo = resolveRepo(deps);

    const pageLimit = Math.min(Math.max(1, Number(limit) || 200), 1000);

    // For postgres, the repo.manifest handles pagination via cursor.
    // snapshotSeq: for first page, we read oss_change_seq from teamWorkspaceConfig;
    // for subsequent pages, caller supplies snapshotSeq.
    let snapshotSeq: number;
    if (typeof clientSnapshotSeq === 'number') {
      snapshotSeq = clientSnapshotSeq;
    } else {
      // Read snapshotSeq from DB
      const db = deps.db ?? getDb();
      const [twc] = await db
        .select({ ossChangeSeq: teamWorkspaceConfig.ossChangeSeq })
        .from(teamWorkspaceConfig)
        .where(eq(teamWorkspaceConfig.teamId, teamId))
        .limit(1);
      if (!twc) {
        return json(404, { error: 'team not found or not configured for OSS sync' });
      }
      snapshotSeq = twc.ossChangeSeq;
    }

    const result = await repo.manifest({
      teamId,
      afterSeq: Number(afterSeq) || 0,
      snapshotSeq,
      cursor: cursor as string | undefined,
      limit: pageLimit,
    });

    const items = result.files.map(r => ({
      path:        r.path,
      version:     r.currentVersion,
      contentHash: r.contentHash,
      size:        r.size,
      deleted:     r.deleted,
      changeSeq:   r.changeSeq,
      updatedAt:   r.updatedAt,
      updatedBy:   r.updatedBy,
    }));

    return json(200, {
      snapshotSeq,
      items,
      nextCursor: result.nextCursor ?? null,
    });
  }

  // --- supabase path (unchanged) ---
  const supabase = createServiceRoleClient();

  // Read current snapshot seq if client didn't supply one (first page).
  let snapshotSeq: number;
  if (typeof clientSnapshotSeq === 'number') {
    snapshotSeq = clientSnapshotSeq;
  } else {
    const { data: twc, error: twcErr } = await supabase
      .from('team_workspace_config')
      .select('oss_change_seq')
      .eq('team_id', teamId)
      .single();
    if (twcErr || !twc) {
      return json(404, { error: 'team not found or not configured for OSS sync' });
    }
    snapshotSeq = (twc as any).oss_change_seq;
  }

  // Decode cursor: base64 JSON { seq, id }
  let cursorSeq = 0;
  let cursorId  = '00000000-0000-0000-0000-000000000000';
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor as string, 'base64').toString('utf8'));
      cursorSeq = decoded.seq;
      cursorId  = decoded.id;
    } catch {
      return json(400, { error: 'invalid cursor' });
    }
  }

  const pageLimit = Math.min(Math.max(1, Number(limit) || 200), 1000);

  const { data: rows, error } = await supabase
    .from('amuxc_files')
    .select('id, path, current_version, content_hash, size, deleted, change_seq, updated_at, updated_by')
    .eq('team_id', teamId)
    .gt('change_seq', afterSeq)
    .lte('change_seq', snapshotSeq)
    .or(`change_seq.gt.${cursorSeq},and(change_seq.eq.${cursorSeq},id.gt.${cursorId})`)
    .order('change_seq', { ascending: true })
    .order('id', { ascending: true })
    .limit(pageLimit + 1);

  if (error) {
    return json(500, { error: `manifest query failed: ${error.message}` });
  }

  const hasMore = (rows as any[]).length > pageLimit;
  const items = (hasMore ? (rows as any[]).slice(0, pageLimit) : (rows as any[])).map(r => ({
    path:            r.path,
    version:         r.current_version,
    contentHash:     r.content_hash,
    size:            r.size,
    deleted:         r.deleted,
    changeSeq:       r.change_seq,
    updatedAt:       r.updated_at,
    updatedBy:       r.updated_by,
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = items[items.length - 1];
    const lastRow = (rows as any[]).find(r => r.change_seq === last.changeSeq && r.path === last.path);
    nextCursor = Buffer.from(JSON.stringify({ seq: last.changeSeq, id: lastRow.id })).toString('base64');
  }

  return json(200, { snapshotSeq, items, nextCursor });
}

// ---------------------------------------------------------------------------
// §3.2  POST /sync/upload/prepare
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, path, parentVersion, contentHash, size, nodeId }
 */
export async function handleSyncUploadPrepare(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { path, parentVersion, contentHash, size, nodeId } = body || {};

  // Validate path (spec §3.1.1)
  const pathCheck = validateSyncPath(path as string);
  if (!pathCheck.ok) {
    return json(422, { error: pathCheck.message, code: pathCheck.code });
  }

  // Server-side backstop, WRITE PATH ONLY. A client that predates the ignore
  // rules still pushes whatever it likes, and `/v1/sync/*` is exempt from the
  // per-IP limiter, so this is the only ceiling left. Deliberately not in
  // `validateSyncPath`: that runs on the pull side too, where one rejected
  // historical row aborts the whole manifest apply.
  if (isRejectedSyncPath(path as string)) {
    return json(422, {
      error: `path is excluded from sync: ${path}`,
      code: 'IgnoredPath',
    });
  }

  if (!contentHash || typeof contentHash !== 'string') {
    return json(400, { error: 'contentHash is required' });
  }
  if (typeof size !== 'number' || size < 0) {
    return json(400, { error: 'size must be a non-negative number' });
  }
  if (typeof parentVersion !== 'number' || parentVersion < 0) {
    return json(400, { error: 'parentVersion must be a non-negative integer' });
  }

  const { teamId, actorId } = caller;

  // Volume ceiling. Unlike the name list this cannot produce a false positive:
  // it only fires on an amount that is a problem whatever the files are called.
  // A count that could not be established allows the write — see `liveFileCount`.
  const count = await liveFileCount(teamId, (id) => countLiveFiles(id, deps));
  if (isOverFileQuota(count)) {
    return json(422, {
      error: `team is at its file limit (${count} of ${maxFilesPerTeam()}); remove files or raise SYNC_MAX_FILES_PER_TEAM`,
      code: 'QuotaExceeded',
    });
  }

  // Byte ceiling on live pointers only (not historical blobs). Batch prepare
  // applies a running total itself and sets skipByteQuota.
  if (!deps.skipByteQuota) {
    const sum = await liveByteSum(teamId, (id) => sumLiveBytes(id, deps));
    if (isOverByteQuota(sum === null ? null : sum + size)) {
      return json(422, {
        error: `team is at its byte limit (${sum} + ${size} of ${maxBytesPerTeam()}); remove files or raise SYNC_MAX_BYTES_PER_TEAM`,
        code: 'QuotaExceeded',
        kind: 'bytes',
      });
    }
  }

  const ossKey = ossKeyForHash(teamId, contentHash);
  const storage = resolveStorage(deps);

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const repo = resolveRepo(deps);

    const known = await repo.download({ teamId, contentHash });

    const expiresAt = new Date(Date.now() + 3600_000);
    const sessionId = await repo.uploadPrepare({
      teamId,
      actorId,
      nodeId: (nodeId as string | undefined) ?? null,
      path: path as string,
      parentVersion,
      contentHash,
      size,
      ossKey,
      expiresAt,
    });

    const requiresUpload = await blobRequiresUpload(
      storage,
      ossKey,
      size,
      Boolean(known?.verified),
    );
    const presignedPut = requiresUpload ? await storage.createUploadUrl(ossKey) : null;

    return json(200, {
      uploadSessionId: sessionId,
      ossKey,
      requiresUpload,
      presignedPut,
    });
  }

  // --- supabase path ---
  const supabase = createServiceRoleClient();

  // Read before upsert: `ignoreDuplicates` makes the upsert a no-op on an
  // existing row, so it can neither tell us nor clear an existing `verified`.
  const { data: known } = await supabase
    .from('amuxc_blobs')
    .select('verified')
    .eq('team_id', teamId)
    .eq('content_hash', contentHash)
    .maybeSingle();

  await supabase
    .from('amuxc_blobs')
    .upsert(
      { team_id: teamId, content_hash: contentHash, oss_key: ossKey, size, verified: false },
      { onConflict: 'team_id,content_hash', ignoreDuplicates: true }
    );

  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const { data: session, error: sessionErr } = await supabase
    .from('amuxc_upload_sessions')
    .insert({
      team_id: teamId,
      actor_id: actorId,
      node_id: nodeId || null,
      path,
      parent_version: parentVersion,
      content_hash: contentHash,
      size,
      oss_key: ossKey,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (sessionErr) {
    return json(500, { error: `Failed to create upload session: ${sessionErr.message}` });
  }

  const requiresUpload = await blobRequiresUpload(
    storage,
    ossKey,
    size,
    Boolean((known as any)?.verified),
  );
  const presignedPut = requiresUpload ? await storage.createUploadUrl(ossKey) : null;

  return json(200, {
    uploadSessionId: (session as any).id,
    ossKey,
    requiresUpload,
    presignedPut,
  });
}

// ---------------------------------------------------------------------------
// §3.3  POST /sync/upload/complete
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { uploadSessionId }
 */
export async function handleSyncUploadComplete(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { uploadSessionId } = body || {};
  if (!uploadSessionId) {
    return json(400, { error: 'uploadSessionId is required' });
  }

  const { teamId, actorId } = caller;
  const storage = resolveStorage(deps);

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const repo = resolveRepo(deps);

    // We need to fetch the session first to get oss_key + size for HEAD check.
    // The repo.completeUpload will re-fetch + lock inside the transaction.
    const db = deps.db ?? getDb();
    const [session] = await db
      .select()
      .from(amuxcUploadSessions)
      .where(eq(amuxcUploadSessions.id, uploadSessionId as string))
      .limit(1);

    if (!session) return json(404, { error: 'upload session not found' });
    if (session.teamId !== teamId) return json(403, { error: 'session does not belong to this team' });

    // Verify the bytes actually landed before marking the version live.
    try {
      const stat = await storage.stat(session.ossKey);
      if (!stat || stat.size !== session.size) {
        return json(422, {
          error: 'BlobMissingOrSizeMismatch',
          expected: session.size,
          actual: stat?.size ?? null,
        });
      }
    } catch (e: any) {
      return json(422, { error: 'BlobMissingOrSizeMismatch', detail: e.message });
    }

    try {
      const result = await repo.completeUpload(uploadSessionId as string, actorId);
      return publishHintAfterSingle(
        caller,
        body,
        json(200, {
          version:     result.version,
          contentHash: result.contentHash,
          changeSeq:   result.changeSeq,
        }),
        deps,
      );
    } catch (e: any) {
      if (e instanceof ApiError) {
        if (e.statusCode === 409) return json(409, { reason: 'cas-mismatch', remoteVersion: undefined, remoteHash: undefined });
        if (e.statusCode === 403) return json(403, { error: e.message });
        if (e.statusCode === 410) return json(410, { error: e.message });
        if (e.statusCode === 404) return json(404, { error: e.message });
      }
      console.error('[sync/complete] pg error:', e);
      return json(500, { error: `complete failed: ${e.message}` });
    }
  }

  // --- supabase path (unchanged) ---
  const supabase = createServiceRoleClient();

  const { data: session, error: sessionErr } = await supabase
    .from('amuxc_upload_sessions')
    .select('*')
    .eq('id', uploadSessionId)
    .single();

  if (sessionErr || !session) {
    return json(404, { error: 'upload session not found' });
  }
  if ((session as any).team_id !== teamId) {
    return json(403, { error: 'session does not belong to this team' });
  }
  if ((session as any).actor_id !== actorId) {
    return json(403, { error: 'session does not belong to caller' });
  }
  if ((session as any).status !== 'pending') {
    return json(410, { error: `upload session is ${(session as any).status}` });
  }
  if (new Date((session as any).expires_at) < new Date()) {
    return json(410, { error: 'upload session has expired' });
  }

  try {
    const stat = await storage.stat((session as any).oss_key);
    if (!stat || stat.size !== (session as any).size) {
      return json(422, {
        error: 'BlobMissingOrSizeMismatch',
        expected: (session as any).size,
        actual: stat?.size ?? null,
      });
    }
  } catch (e: any) {
    return json(422, { error: 'BlobMissingOrSizeMismatch', detail: e.message });
  }

  const { data: rpcResult, error: rpcErr } = await supabase
    .schema("amux").rpc('amuxc_complete_upload', {
      p_session_id: uploadSessionId,
      p_actor_id: actorId,
    });

  if (rpcErr) {
    if (rpcErr.code === 'P0409' || rpcErr.message?.includes('cas-mismatch')) {
      let remoteVersion, remoteHash;
      try {
        const detail = JSON.parse(rpcErr.hint || (rpcErr as any).details || '{}');
        remoteVersion = detail.remote_version;
        remoteHash    = detail.remote_hash;
      } catch { /* ignored */ }
      return json(409, { reason: 'cas-mismatch', remoteVersion, remoteHash });
    }
    if (rpcErr.code === 'P0403') {
      return json(403, { error: rpcErr.message });
    }
    if (rpcErr.code === 'P0410') {
      return json(410, { error: rpcErr.message });
    }
    console.error('[sync/complete] RPC error:', rpcErr);
    return json(500, { error: `complete failed: ${rpcErr.message}` });
  }

  if (!rpcResult || (rpcResult as any[]).length === 0) {
    return json(500, { error: 'complete RPC returned no result' });
  }

  const result = (rpcResult as any[])[0];
  return publishHintAfterSingle(
    caller,
    body,
    json(200, {
      version:     result.version,
      contentHash: result.content_hash,
      changeSeq:   result.change_seq,
    }),
    deps,
  );
}

// ---------------------------------------------------------------------------
// §3.4  POST /sync/download
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, contentHash }
 */
export async function handleSyncDownload(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { contentHash } = body || {};
  if (!contentHash || typeof contentHash !== 'string') {
    return json(400, { error: 'contentHash is required' });
  }

  const { teamId } = caller;
  const storage = resolveStorage(deps);

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const repo = resolveRepo(deps);
    const blob = await repo.download({ teamId, contentHash });

    if (!blob) return json(404, { error: 'blob not found' });
    if (!blob.verified) return json(404, { error: 'blob not yet verified (upload not completed)' });

    const downloadUrl = await storage.createDownloadUrl(blob.ossKey, DOWNLOAD_TTL_SEC);

    return json(200, { downloadUrl, size: blob.size, ttlSec: DOWNLOAD_TTL_SEC });
  }

  // --- supabase path (unchanged) ---
  const supabase = createServiceRoleClient();

  const { data: blob, error } = await supabase
    .from('amuxc_blobs')
    .select('oss_key, size, verified')
    .eq('team_id', teamId)
    .eq('content_hash', contentHash)
    .single();

  if (error || !blob) {
    return json(404, { error: 'blob not found' });
  }
  if (!(blob as any).verified) {
    return json(404, { error: 'blob not yet verified (upload not completed)' });
  }

  const downloadUrl = await storage.createDownloadUrl((blob as any).oss_key, DOWNLOAD_TTL_SEC);

  return json(200, { downloadUrl, size: (blob as any).size, ttlSec: DOWNLOAD_TTL_SEC });
}

// ---------------------------------------------------------------------------
// §3.5  POST /sync/delete
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} body - { teamId, path, parentVersion, nodeId }
 */
export async function handleSyncDelete(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { path, parentVersion, nodeId } = body || {};

  const pathCheck = validateSyncPath(path as string);
  if (!pathCheck.ok) {
    return json(422, { error: pathCheck.message, code: pathCheck.code });
  }
  if (typeof parentVersion !== 'number' || parentVersion < 0) {
    return json(400, { error: 'parentVersion must be a non-negative integer' });
  }

  const { teamId, actorId } = caller;

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const repo = resolveRepo(deps);

    try {
      const result = await repo.completeDelete({
        teamId,
        path: path as string,
        parentVersion,
        actorId,
        nodeId: (nodeId as string | undefined) ?? null,
      });
      return publishHintAfterSingle(
        caller,
        body,
        json(200, { version: result.version, changeSeq: result.changeSeq }),
        deps,
      );
    } catch (e: any) {
      if (e instanceof ApiError) {
        if (e.statusCode === 409) return json(409, { reason: 'cas-mismatch', remoteVersion: undefined, remoteHash: undefined });
        if (e.statusCode === 404) return json(404, { error: 'file not found' });
      }
      console.error('[sync/delete] pg error:', e);
      return json(500, { error: `delete failed: ${e.message}` });
    }
  }

  // --- supabase path (unchanged) ---
  const supabase = createServiceRoleClient();

  const { data: rpcResult, error: rpcErr } = await supabase
    .schema("amux").rpc('amuxc_complete_delete', {
      p_team_id:       teamId,
      p_path:          path,
      p_parent_version: parentVersion,
      p_actor_id:      actorId,
      p_node_id:       nodeId || null,
    });

  if (rpcErr) {
    if (rpcErr.code === 'P0409' || rpcErr.message?.includes('cas-mismatch')) {
      let remoteVersion, remoteHash;
      try {
        const detail = JSON.parse(rpcErr.hint || (rpcErr as any).details || '{}');
        remoteVersion = detail.remote_version;
        remoteHash    = detail.remote_hash;
      } catch { /* ignored */ }
      return json(409, { reason: 'cas-mismatch', remoteVersion, remoteHash });
    }
    if (rpcErr.code === 'P0404') {
      return json(404, { error: 'file not found' });
    }
    console.error('[sync/delete] RPC error:', rpcErr);
    return json(500, { error: `delete failed: ${rpcErr.message}` });
  }

  if (!rpcResult || (rpcResult as any[]).length === 0) {
    return json(500, { error: 'delete RPC returned no result' });
  }

  const result = (rpcResult as any[])[0];
  return publishHintAfterSingle(
    caller,
    body,
    json(200, {
      version:   result.version,
      changeSeq: result.change_seq,
    }),
    deps,
  );
}

// ---------------------------------------------------------------------------
// §3.6  GET /sync/versions
// ---------------------------------------------------------------------------

/**
 * @param {{ userId, teamId, actorId }} caller
 * @param {object} query - { teamId, path, limit?, cursor? }
 */
export async function handleSyncVersions(
  caller: { userId: string; teamId: string; actorId: string },
  query: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { path, limit = 50, cursor = null } = query || {};

  if (!path || typeof path !== 'string') {
    return json(400, { error: 'path query param is required' });
  }

  const { teamId } = caller;

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const repo = resolveRepo(deps);

    const pageLimit = Math.min(Math.max(1, Number(limit) || 50), 500);
    const result = await repo.versions({
      teamId,
      path,
      cursor: cursor as string | undefined,
      limit: pageLimit,
    });

    if (result.versions.length === 0) {
      // versions() returns [] if file not found — disambiguate with not found
      return json(404, { error: 'file not found' });
    }

    const versions = result.versions.map(r => ({
      version:          r.version,
      parentVersion:    r.parentVersion,
      contentHash:      r.contentHash,
      size:             r.size,
      deleted:          r.deleted,
      createdAt:        r.createdAt,
      createdBy:        r.createdBy,
      createdByNodeId:  r.createdByNodeId,
      message:          null, // pg schema doesn't store message field yet
    }));

    return json(200, { versions, nextCursor: result.nextCursor ?? null });
  }

  // --- supabase path (unchanged) ---
  const supabase = createServiceRoleClient();

  const { data: fileRow, error: fileErr } = await supabase
    .from('amuxc_files')
    .select('id')
    .eq('team_id', teamId)
    .eq('path', path)
    .single();

  if (fileErr || !fileRow) {
    return json(404, { error: 'file not found' });
  }

  const pageLimit = Math.min(Math.max(1, Number(limit) || 50), 500);

  let cursorVersion = 2147483647;
  let cursorId      = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor as string, 'base64').toString('utf8'));
      cursorVersion = decoded.version;
      cursorId      = decoded.id;
    } catch {
      return json(400, { error: 'invalid cursor' });
    }
  }

  const { data: rows, error } = await supabase
    .from('amuxc_file_versions')
    .select('id, version, parent_version, content_hash, size, deleted, created_at, created_by, created_by_node_id, message')
    .eq('file_id', (fileRow as any).id)
    .or(`version.lt.${cursorVersion},and(version.eq.${cursorVersion},id.lt.${cursorId})`)
    .order('version', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageLimit + 1);

  if (error) {
    return json(500, { error: `versions query failed: ${error.message}` });
  }

  const hasMore = (rows as any[]).length > pageLimit;
  const versions = (hasMore ? (rows as any[]).slice(0, pageLimit) : (rows as any[])).map(r => ({
    version:          r.version,
    parentVersion:    r.parent_version,
    contentHash:      r.content_hash,
    size:             r.size,
    deleted:          r.deleted,
    createdAt:        r.created_at,
    createdBy:        r.created_by,
    createdByNodeId:  r.created_by_node_id,
    message:          r.message,
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = (rows as any[])[pageLimit - 1];
    nextCursor = Buffer.from(JSON.stringify({ version: last.version, id: last.id })).toString('base64');
  }

  return json(200, { versions, nextCursor });
}

// ---------------------------------------------------------------------------
// POST /sync/set-mode — owner-only sync_mode switch (Tranche 5)
// ---------------------------------------------------------------------------
/**
 * Switch a team's sync_mode.
 * Body: { teamId: string, mode: 'git' | 'oss' }
 * Returns: { mode: string } | 400 | 403
 */
export async function handleSyncSetMode(
  userId: string,
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { teamId, mode } = body ?? {};
  if (!teamId) return json(400, { error: 'teamId is required' });
  if (!mode) return json(400, { error: 'mode is required' });
  if (mode !== 'git' && mode !== 'oss') return json(400, { error: `invalid mode: ${mode}` });

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const db = deps.db ?? getDb();
    const repo = resolveRepo(deps);

    // Resolve userId → actorId (ownership checked inside repo)
    const actorId = await resolveActorForTeam(db, userId, teamId as string);
    if (!actorId) return json(403, { error: 'caller is not a member of this team' });

    try {
      await repo.setTeamSyncMode(teamId as string, mode as 'git' | 'oss', actorId);
      return json(200, { mode });
    } catch (e: any) {
      if (e instanceof ApiError) {
        if (e.statusCode === 400) return json(400, { error: e.message });
        if (e.statusCode === 403) return json(403, { error: e.message });
      }
      return json(500, { error: e.message });
    }
  }

  // --- supabase path (unchanged) ---
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .schema("amux").rpc('set_team_sync_mode', { p_team_id: teamId, p_mode: mode });

  if (error) {
    const code = error.code;
    if (code === '22023') return json(400, { error: error.message });
    if (code === '42501') return json(403, { error: error.message });
    return json(500, { error: error.message });
  }

  return json(200, { mode: data ?? mode });
}

// ---------------------------------------------------------------------------
// POST /sync/team-mode — read team sync_mode (Tranche 5)
// ---------------------------------------------------------------------------
/**
 * Return the sync_mode for a team (read-only).
 * Body: { teamId: string }
 * Returns: { mode: 'git' | 'oss' | null }
 */
export async function handleSyncTeamMode(
  userId: string,
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const { teamId } = body ?? {};
  if (!teamId) return json(400, { error: 'teamId is required' });

  if (resolveBackendKind() === 'postgres') {
    // --- postgres path ---
    const repo = resolveRepo(deps);

    try {
      const mode = await repo.getTeamSyncMode(teamId as string);
      return json(200, { mode });
    } catch (e: any) {
      return json(500, { error: e.message });
    }
  }

  // --- supabase path (unchanged) ---
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .schema("amux").rpc('get_team_sync_mode', { p_team_id: teamId });

  if (error) {
    return json(500, { error: error.message });
  }

  return json(200, { mode: data ?? null });
}

// ---------------------------------------------------------------------------
// Batch endpoints — fan-outs over the single-item handlers above.
//
// Body shape: { teamId, items: [ <single-item body minus teamId>, … ] }
// Response:   200 { results: [ { ok, … } per item, same order/length ] }
//
// `teamId` + auth are resolved once by the router (legacy-sync.ts) and shared
// across all items via `caller`. See runSyncBatch for the per-item contract.
// ---------------------------------------------------------------------------

/** POST /sync/upload/prepare-batch — N prepare ops in one round-trip. */
export async function handleSyncUploadPrepareBatch(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  // One live sum per batch; running total so later items see earlier ones.
  // Sum failure → null → allow (same policy as single prepare).
  const sum = await liveByteSum(caller.teamId, (id) => sumLiveBytes(id, deps));
  let running = sum ?? 0;
  const sumKnown = sum !== null;
  let crossed = false;

  return runSyncBatch(body?.items, async (item) => {
    // Only a NEW path adds bytes to the team. `parentVersion === 0` is the
    // client saying "no row for this path yet"; anything higher is an edit
    // whose old bytes are ALREADY inside `sum`, so charging its full size
    // counted the file twice — 200 edits totalling 600 MB looked like 600 MB of
    // growth and pushed a team at 1.5 GiB over a 2 GiB quota that completing
    // them would have left untouched. A quota that fires on writes a team is
    // nowhere near its limit is worse than one that lets a batch overshoot.
    //
    // The trade is a bounded under-count: an edit that GROWS a file is charged
    // nothing until the next call re-reads the live sum, so the overshoot can
    // never exceed one batch (≤200 items). That is the right direction for a
    // guard whose job is stopping pathological bulk adds.
    const size = typeof item.size === 'number' ? item.size : NaN;
    const parentVersion =
      typeof item.parentVersion === 'number' ? item.parentVersion : NaN;
    const charge =
      sumKnown && parentVersion === 0 && Number.isFinite(size) && size >= 0 ? size : 0;

    if (crossed || (charge > 0 && isOverByteQuota(running + charge))) {
      crossed = true;
      return json(422, {
        error: `team is at its byte limit (${running} + ${charge} of ${maxBytesPerTeam()}); remove files or raise SYNC_MAX_BYTES_PER_TEAM`,
        code: 'QuotaExceeded',
        kind: 'bytes',
      });
    }

    const result = await handleSyncUploadPrepare(caller, item, {
      ...deps,
      skipByteQuota: true,
    });

    // Charge only what actually got an upload slot. A rejected item
    // (IgnoredPath, bad CAS, validation) never becomes bytes, and burning
    // budget for it refused every later valid note in the same batch.
    if (charge > 0 && result.statusCode >= 200 && result.statusCode < 300) {
      running += charge;
    }
    return result;
  });
}

/** POST /sync/upload/complete-batch — N CAS completes; per-item ok/conflict/error. */
export async function handleSyncUploadCompleteBatch(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const envelope = await runSyncBatch(body?.items, (item) =>
    handleSyncUploadComplete(caller, item, { ...deps, suppressSyncHint: true }),
  );
  await publishHintAfterBatch(caller, body, envelope, deps);
  return envelope;
}

/** POST /sync/download-batch — N presigned GET URLs in one round-trip. */
export async function handleSyncDownloadBatch(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  return runSyncBatch(body?.items, (item) => handleSyncDownload(caller, item, deps));
}

/** POST /sync/delete-batch — N tombstone CAS ops; per-item ok/conflict/error. */
export async function handleSyncDeleteBatch(
  caller: { userId: string; teamId: string; actorId: string },
  body: Record<string, unknown> | undefined,
  deps: SyncHandlerDeps = {},
) {
  const envelope = await runSyncBatch(body?.items, (item) =>
    handleSyncDelete(caller, item, { ...deps, suppressSyncHint: true }),
  );
  await publishHintAfterBatch(caller, body, envelope, deps);
  return envelope;
}
