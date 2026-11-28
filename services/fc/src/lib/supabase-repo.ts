/**
 * The business repository — PostgREST + caller JWT + RLS.
 *
 * Contract: lib/repository-contract.ts.
 */
import { randomUUID } from "node:crypto";
import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import { verifyTrustedExternalJwt } from "./trusted-external-jwt.js";
import { aiGateway } from "./ai-gateway.js";
import { createCheckoutSession, listCreditPackages } from "./stripe.js";
import { ApiError } from "./http-utils.js";
import { assertTeamSkillSlug, canonicalTeamSkillSlug, teamSkillDisplayName } from "./team-skill-slug.js";
import {
  lookupMemberInboxRecipients,
  publishSessionParticipantsChanged,
  removedMemberUserId,
} from "./session-participant-notify.js";
import { buildSessionReadInboxPayload } from "./push-dispatch.js";
import { ADMIN_LIST_CAP, clampPage, IN_FILTER_BATCH, jwtSessionId, resolvePlatformOperator, safeSearch } from "./platform-operators.js";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MESSAGE_LIST_LIMIT,
  MAX_MESSAGE_LIST_LIMIT,
  encodeSessionAttachmentCursor,
} from "./routing-utils.js";
import {
  aggregateSessionAttachmentsFromMessages,
  paginateSessionAttachments,
} from "./session-attachments/aggregate-list.js";

import { resolveFeatures } from "./routes/config.js";
import { encodeStorageObjectKeyForUrl } from "./storage-object-key.js";

/**
 * Self-registration switch, resolved per request from the deployment's feature
 * profile. Unset means allowed — every deployment behaves as it does today
 * until someone turns it off. See FeatureFlags.allowNewOrg for why this gates
 * "mint an org" rather than "create a team", and why it is FC-only.
 */
/**
 * Rows after the cursor in (updated_at desc, id desc) order.
 *
 * `updated_at < cursor` alone skipped every row sharing the last row's
 * timestamp, and bulk writes do share one (a belayo team had two such pairs).
 * The values are double-quoted for PostgREST's `or` grammar (a timestamp holds
 * `:` and `+`); the cursor comes from the client, so anything that could close
 * the quote is refused rather than escaped.
 */
export function applyWorkspaceKeysetCursor<Q extends { or(filter: string): Q; lt(column: string, value: string): Q }>(
  query: Q,
  cursor: { updatedAt: string; id?: string | null },
): Q {
  return applyKeysetCursor(query, "updated_at", cursor.updatedAt, cursor.id);
}

/** [`applyWorkspaceKeysetCursor`]'s rule on any (column desc, id desc) sort. */
export function applyKeysetCursor<Q extends { or(filter: string): Q; lt(column: string, value: string): Q }>(
  query: Q,
  column: string,
  at: string,
  rawId?: string | null,
): Q {
  const value = String(at);
  const id = rawId == null ? null : String(rawId);
  const safe = (v: string) => /^[0-9A-Za-z:.+\- T]+$/.test(v);
  if (!safe(value) || (id !== null && !safe(id))) {
    throw new ApiError(400, "validation_failed", "Invalid cursor");
  }
  if (!id) return query.lt(column, value);
  return query.or(`${column}.lt."${value}",and(${column}.eq."${value}",id.lt."${id}")`);
}

function newOrgAllowed(): boolean {
  return resolveFeatures().allowNewOrg !== false;
}

function assertNewOrgAllowed(): void {
  if (!newOrgAllowed()) {
    throw new ApiError(
      403,
      "registration_disabled",
      "self-registration is disabled on this deployment",
    );
  }
}

function mapJoinLinkAdminError(error: { code?: string; message?: string }): never {
  const code = error?.code || "";
  const msg = error?.message ?? "";
  if (code === "42501" && msg.includes("升级账号后才能邀请成员加入团队")) {
    throw new ApiError(403, "upgrade_required", "升级账号后才能邀请成员加入团队");
  }
  if (code === "42501" && msg.includes("team owner or admin access required")) {
    throw new ApiError(403, "forbidden", "team owner or admin access required");
  }
  if (code === "P0002" || msg.includes("link_not_found")) {
    throw new ApiError(404, "not_found", "link_not_found");
  }
  if (code === "22023") {
    throw new ApiError(400, "validation_failed", msg || "invalid join link");
  }
  throw error;
}

function mapTeamJoinLinkRow(row: any) {
  return {
    token: requiredString(row.token, "teams.joinLink", "token"),
    expiresAt: row.expires_at ?? null,
    maxUses: row.max_uses ?? null,
    useCount: Number(row.use_count ?? 0),
    status: requiredString(row.status, "teams.joinLink", "status"),
    createdAt: requiredString(row.created_at, "teams.joinLink", "created_at"),
  };
}

/** Map the turn-trace RPCs' SQLSTATEs onto HTTP errors. */
function turnTraceRpcError(error: { code?: string; message?: string }): unknown {
  if (error.code === "P0002") return new ApiError(404, "not_found", "message not found");
  if (error.code === "42501") {
    return new ApiError(403, "forbidden", "only the agent that wrote this reply may attach its trace");
  }
  if (error.code === "22023") {
    return new ApiError(400, "validation_failed", error.message ?? "invalid trace");
  }
  return error;
}

import { makeSupabaseMarketplaceMethods } from "./supabase-repo/marketplace.js";
import { makeDocumentLibrariesRepo } from "./supabase-repo/document-libraries.js";
import { makeKnowledgeAclRepo } from "./supabase-repo/knowledge-acl.js";
import { makeWikiMaintainerRepo } from "./supabase-repo/wiki-maintainer.js";
import { makeAppsRepo } from "./app-platform/service/apps.js";
import { makeTeamCluAppsRepo } from "./teamclu-apps/repo.js";
import { teamCluAppTenant } from "./teamclu-apps/tenant.js";
import { noTeamCluForge } from "./teamclu-apps/forge.js";
import {
  assignSystemOrgRole,
  enrichActorsWithOrgRoles,
  makeOrgRolesRepo,
} from "./supabase-repo/org-roles.js";
// Backend-neutral request validation — keep free of PostgREST calls.
import {
  assertTransportShape as assertTeamMcpTransportShape,
  readServerFields as readTeamMcpServerFields,
  NAME_RE as TEAM_MCP_NAME_RE,
} from "./validation/team-mcp.js";
import {
  assertWritableKeyId as assertWritableTeamEnvKeyId,
  readEnvelope as readTeamEnvEnvelope,
} from "./validation/team-env-secrets.js";
import { readRuntimeCatalog as defaultReadRuntimeCatalog } from "./provisioning/app-runtime-catalog.js";
import { readAppFunction as defaultReadAppFunction, validateAppOrigin as defaultValidateAppOrigin, readAppOriginSecurity as defaultReadAppOriginSecurity } from "./provisioning/app-runtime-info.js";
import {
  needsDatabase,
  readAppsCloudApiUrl,
} from "./provisioning/app-deploy.js";


/**
 * AAD for one env secret, so a sealed value cannot be replayed under another
 * key's name — the same reason `seal` binds `kind` for the platform's own
 * secrets. Moving a ciphertext from STRIPE_TEST_KEY to STRIPE_LIVE_KEY by
 * editing the row would otherwise decrypt cleanly.
 */
function appEnvSecretKind(key: string): string {
  return `env:${key}`;
}
import { normalizeAgentTypes } from "./agent-types.js";
import { isListableAgentStatus, LISTABLE_AGENT_STATUS_OR_FILTER } from "./agent-status.js";
import { adminTypeOf, isMember } from "./admin-type.js";
import {
  REALTIME_TRANSPORT_OPTS,
  requiredRow,
  requiredString,
  DEFAULT_ATTACHMENT_BUCKET,
  TEAM_COLUMNS,
  MESSAGE_COLUMNS,
  MESSAGE_ATTACHMENT_SCAN_COLUMNS,
  WORKSPACE_COLUMNS,
  mapDefaultAgentError,
  APP_COLUMNS,
  appIso,
  mapApp,
  SESSION_FULL_COLUMNS,
  ACTOR_DIRECTORY_COLUMNS,
  mapSessionFull,
  mapDirectoryActor,
  publishableKeyFromEnv,
  outgoingMessageRow,
  mapTeam,
  mapSession,
  mapMessage,
  mapWorkspace,
  mapShortcut,
  mapIdeaRow,
  mapIdeaFeedRow,
  mapShortcutRow,
  mapIdeaActivityRow,
  mapFeedbackRow,
  mapLeaderboardRow,
  chunkedIn,
} from "./supabase-repo/shared.js";
export { publishableKeyFromEnv } from "./supabase-repo/shared.js";
export { createSupabaseAuthRepository } from "./supabase-repo/auth.js";

/**
 * Longest PostgREST URL we let out of this process.
 *
 * kong rejects request lines past its header buffer with 414. 4KB is well
 * under that, so a hit here is a design smell (an unchunked `.in()`) caught
 * long before it becomes an outage — not a near-miss on the real limit.
 */
const MAX_UPSTREAM_URL_BYTES = 4096;

/**
 * Fail loudly in tests, report in production. An over-long URL means some
 * `.in()` escaped `chunkedIn`; letting it through in prod is still better than
 * refusing the request, because kong's 414 is the outage we are guarding, not
 * this check.
 */
function guardedFetch(input: any, init?: any) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.length > MAX_UPSTREAM_URL_BYTES) {
    const message =
      `PostgREST URL is ${url.length} bytes (limit ${MAX_UPSTREAM_URL_BYTES}) — ` +
      `an .in() filter is missing chunkedIn(). Path: ${url.slice(0, 200)}…`;
    if (process.env.NODE_ENV === "test") throw new Error(message);
    console.warn(`[supabase-repo] ${message}`);
    // Surfaced to Sentry via the console integration when configured; no hard
    // dependency on the SDK here so unit tests and the FC target stay identical.
  }
  return fetch(input, init);
}

/**
 * Agent seats carry a workspace (ADR-0005); member seats do not.
 * Callers that already picked a folder pass it in `overrideByActorId`.
 */
async function workspaceIdByAgentActor(
  supabase: any,
  actorIds: string[],
  overrideByActorId: Record<string, string> = {},
): Promise<Map<string, string>> {
  const ids = [...new Set(actorIds.filter((id) => typeof id === "string" && id.length > 0))];
  const defaults = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await chunkedIn(ids, async (chunk: string[]) => {
      const { data, error } = await supabase
        .from("agents")
        .select("id, default_workspace_id")
        .in("id", chunk);
      if (error) throw error;
      return data ?? [];
    });
    for (const row of rows) {
      const id = typeof row?.id === "string" ? row.id.trim() : "";
      const workspaceId =
        typeof row?.default_workspace_id === "string" ? row.default_workspace_id.trim() : "";
      if (id && workspaceId) defaults.set(id, workspaceId);
    }
  }
  const out = new Map<string, string>();
  for (const actorId of ids) {
    const override =
      typeof overrideByActorId[actorId] === "string" ? overrideByActorId[actorId].trim() : "";
    const workspaceId = override || defaults.get(actorId) || "";
    if (workspaceId) out.set(actorId, workspaceId);
  }
  return out;
}

function participantSeedRow(sessionId: string, actorId: string, workspaceId: string | null) {
  const row: Record<string, string> = { session_id: sessionId, actor_id: actorId };
  if (workspaceId) row.workspace_id = workspaceId;
  return row;
}

/**
 * Archive sessions bound to a workspace via session_participants.workspace_id.
 *
 * This used to read `agent_runtimes`, which 20260803010000 dropped once
 * 20260803000000 moved an agent's per-session working state onto
 * `session_participants` — its natural (session, actor) key. The read was left
 * behind, so every `PATCH /v1/workspaces/:id` with `archived: true` threw
 * `relation "amux.agent_runtimes" does not exist` AFTER the workspace row had
 * already been updated: the caller got a 500, the workspace was archived
 * anyway, and its sessions never were. A retry hit the same wall.
 *
 * `workspace_id` is NULL for member participants (not applicable, not missing),
 * so the equality filter already selects agent rows only.
 */
/**
 * Shared tail of every `*ForSync` reader: keyset on (updated_at, id), ascending,
 * bounded by `limit`.
 *
 * All of them walk FORWARD — the sync contract is "everything changed since X",
 * and `updated_at` is the only column that moves monotonically as rows are
 * touched. Ordering is ascending and id-tiebroken so a cursor is meaningful:
 * without the `id` tiebreak, rows sharing an `updated_at` could be skipped or
 * repeated across a page boundary.
 *
 * PostgREST has no row-value comparison, so `(updated_at, id) > (u, i)` has to
 * be spelled out as the equivalent OR.
 */
function applySyncKeyset(query, cursor, limit) {
  let q = query;
  if (cursor?.updatedAt) {
    q = q.or(
      `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`,
    );
  }
  return q
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
}

function normalizeWorkspacePath(path: string | null | undefined): string | null {
  if (path == null) return null;
  const trimmed = stripWindowsVerbatimPrefix(path.trim().replace(/\\/g, "/"));
  if (!trimmed) return null;
  const isAbs = trimmed.startsWith("/");
  const parts: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join("/");
  if (isAbs) return joined ? `/${joined}` : "/";
  return joined || null;
}

/**
 * Drop Windows' verbatim prefix (`\\?\`), given a path whose backslashes are
 * already forward slashes. Rust's `Path::canonicalize` returns verbatim paths
 * on Windows, and amuxd before the `dunce` fix sent them as-is. Kept, the
 * prefix made the path read as unix-absolute and normalize to `/?/C:/...`,
 * which exists on no machine — every runtime on such a workspace failed with
 * WORKSPACE_PATH_UNAVAILABLE, and the row never matched the same directory
 * registered in plain form, so it was inserted as a duplicate.
 *
 * Also accepts the already-collapsed `/?/` form those rows were stored with.
 *
 * A verbatim UNC path (`\\?\UNC\server\share`) becomes `//server/share` and
 * then normalizes exactly like a plain UNC path does today. That plain-UNC
 * result (one leading slash) is its own, older problem and deliberately not
 * changed here: changing it would re-key existing UNC rows.
 */
function stripWindowsVerbatimPrefix(path: string): string {
  const verbatim = /^\/\/?\?\//.exec(path);
  if (!verbatim) return path;
  const rest = path.slice(verbatim[0].length);
  if (/^UNC\//i.test(rest)) return `//${rest.slice(4)}`;
  if (/^[A-Za-z]:(\/|$)/.test(rest)) return rest;
  return path;
}

/**
 * The workspace named for an agent's seat must be in the session's team, live,
 * and carry a path.
 *
 * It need not be the agent's own row. A workspace is one per (team, path) —
 * `workspaces_team_path_unique` — and its `agent_id` only records who registered
 * it first, so two machines whose folders share a path share one row. Holding
 * the seat to its agent's rows left the second machine unable to be seated in
 * that folder at all. The daemon resolves the id to the path and opens it on its
 * own machine, and refuses a path that does not exist there.
 */
async function assertExplicitWorkspaceBindings(
  supabase: any,
  teamId: string,
  overrideByActorId: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(overrideByActorId).filter(
    ([actorId, workspaceId]) => actorId.trim() && workspaceId.trim(),
  );
  if (entries.length === 0) return;
  const ids = [...new Set(entries.map(([, workspaceId]) => workspaceId.trim()))];
  const rows = await chunkedIn(ids, async (chunk: string[]) => {
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, team_id, agent_id, archived, path")
      .in("id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const [, workspaceId] of entries) {
    const ws = byId.get(workspaceId.trim());
    if (!ws) {
      throw new ApiError(400, "validation_failed", "workspace not found");
    }
    if (String(ws.team_id) !== teamId) {
      throw new ApiError(400, "validation_failed", "workspace team mismatch");
    }
    if (ws.archived === true) {
      throw new ApiError(400, "validation_failed", "workspace archived");
    }
    if (!normalizeWorkspacePath(ws.path)) {
      throw new ApiError(400, "validation_failed", "workspace path empty");
    }
  }
}

async function participantWorkspacesFromBindings(
  supabase: any,
  workspaceByActor: Map<string, string>,
): Promise<Record<string, { workspaceId: string; workspacePath: string | null }>> {
  const ids = [...new Set([...workspaceByActor.values()].filter(Boolean))];
  if (ids.length === 0) return {};
  const rows = await chunkedIn(ids, async (chunk: string[]) => {
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, path")
      .in("id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const out: Record<string, { workspaceId: string; workspacePath: string | null }> = {};
  for (const [actorId, workspaceId] of workspaceByActor) {
    const row = byId.get(workspaceId);
    if (!row) continue;
    out[actorId] = {
      workspaceId,
      workspacePath: typeof row.path === "string" ? row.path : null,
    };
  }
  return out;
}

async function findUniqueWorkspaceName(
  supabase,
  teamId: string,
  agentId: string | null | undefined,
  baseName: string,
): Promise<string> {
  let candidate = baseName;
  let suffix = 2;
  while (true) {
    let query = supabase
      .from("workspaces")
      .select("id")
      .eq("team_id", teamId)
      .eq("name", candidate);
    query = agentId ? query.eq("agent_id", agentId) : query.is("agent_id", null);
    const { data, error } = await query.limit(1);
    if (error) throw error;
    if (!data?.length) return candidate;
    candidate = `${baseName} (${suffix})`;
    suffix += 1;
  }
}

async function loadWorkspaceSessionIds(supabase, workspaceId): Promise<string[]> {
  const { data: participants, error: rtError } = await supabase
    .from("session_participants")
    .select("session_id")
    .eq("workspace_id", workspaceId);
  if (rtError) throw rtError;

  return [...new Set<string>(
    (participants ?? [])
      .map((row) => row.session_id)
      .filter((id) => typeof id === "string" && id.length > 0),
  )];
}

// `archivedAt` is the workspace row's own `updated_at` from the archiving
// UPDATE when there is one: stamping the sessions with that exact instant is
// what lets restoring the workspace find the sessions this archive took with
// it (restoreSessionsForWorkspace) and leave ones archived on their own alone.
async function archiveSessionsForWorkspace(supabase, workspaceId, archivedAt: string = new Date().toISOString()) {
  const sessionIds = await loadWorkspaceSessionIds(supabase, workspaceId);
  if (sessionIds.length === 0) return;

  // Chunked like every other `.in()` here, but this one is an UPDATE: a failure
  // partway leaves earlier chunks archived. Safe because the statement is
  // idempotent (`.is("archived_at", null)` skips rows a retry already touched),
  // so re-running after an error converges rather than double-writing.
  await chunkedIn(sessionIds, async (chunk) => {
    const { error } = await supabase
      .from("sessions")
      .update({ archived_at: archivedAt, updated_at: archivedAt })
      .in("id", chunk)
      .is("archived_at", null);
    if (error) throw error;
    return [];
  });
}

// The inverse of archiveSessionsForWorkspace. Archiving a workspace used to be
// one-way for its sessions: restoring the workspace brought the folder back but
// left every chat in it archived, and no client has an unarchive-session
// control, so to the user the history was simply gone (a customer, 2026-11-26).
// Only sessions stamped with the archive's exact instant come back; a session
// archived by hand before or after keeps its own timestamp and stays archived.
async function restoreSessionsForWorkspace(supabase, workspaceId, archivedAt: string) {
  const sessionIds = await loadWorkspaceSessionIds(supabase, workspaceId);
  if (sessionIds.length === 0) return;

  const restoredAt = new Date().toISOString();
  await chunkedIn(sessionIds, async (chunk) => {
    const { error } = await supabase
      .from("sessions")
      .update({ archived_at: null, updated_at: restoredAt })
      .in("id", chunk)
      .eq("archived_at", archivedAt);
    if (error) throw error;
    return [];
  });
}

export function createSupabaseBusinessRepository(options) {
  const {
    supabaseUrl,
    // Browser-reachable base for public asset URLs. SUPABASE_URL is typically an
    // internal/VPC address the frontend can't reach; fall back to it when unset.
    supabasePublicUrl = supabaseUrl,
    publishableKey,
    accessToken,
    createClient = defaultCreateClient,
    createServiceRoleClient: createServiceRoleClientOpt,
    startDeploy,
    finalizeDeploy,
    // Set when the two above are absent: names the environment variable that
    // made deploy provisioning unavailable (see makeDeployDeps in index.ts).
    deployUnavailableReason,
    // Who hosts an app's code: TeamClu's forge integration (src/lib/forge/),
    // wired in by index.ts. Absent: nobody — imported and local apps only.
    forge: forgeFactory = noTeamCluForge(),
    gotrue,
    gotrueUnavailableReason,
    teardownDeps,
    // The app-data browser's four operations, with the admin connection bound
    // (see makeAppDataOps). Absent when APPS_DB_ADMIN_URL is unset — the
    // reason names the variable so the 503 is actionable.
    appData,
    appDataUnavailableReason,
    // App file storage, with the apps OSS profile bound (see makeAppStorageOps).
    // Absent when the deployment has no apps profile at all; the reason names
    // the variable, for the same why as appDataUnavailableReason above.
    appStorage,
    appStorageUnavailableReason,
    // Reads the deployed function's own logs out of SLS. Absent when the
    // deployment has no Alibaba credentials or no SLS project to point at —
    // the reason names what is missing, as with the two above.
    appLogs,
    appLogsUnavailableReason,
    readRuntimeCatalog = defaultReadRuntimeCatalog,
    readAppFunction = defaultReadAppFunction,
    validateAppOrigin = defaultValidateAppOrigin,
    readAppOriginSecurity = defaultReadAppOriginSecurity,
    trustedExternalJwtSecret = process.env.TRUSTED_EXTERNAL_JWT_SECRET,
    // Optional fan-out hook — called after every successful message INSERT.
    // Best-effort: errors are logged and swallowed so the insert outcome is
    // never affected. It delivers to agent inboxes as well as sending the
    // notifications, hence the name change from `dispatchPush`.
    fanoutMessage,
    // Optional inbox publish for a roster change. Absent in tests and in
    // processes that have no MQTT publisher. Failures are logged and do not
    // change the HTTP result of the seat write. Despite the name it is a plain
    // `inbox/<user_id>` publisher, and app access hints ride it too.
    publishSessionParticipantInbox,
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  if (!accessToken) throw new Error("accessToken is required");

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "amux" }, realtime: REALTIME_TRANSPORT_OPTS,
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      fetch: guardedFetch,
    },
  });

  // A partner-issued session has no auth.sessions row in this Supabase project.
  // Its JWT is verified locally only when the explicit trust secret is set.
  //
  // Every caller-identity read in this file goes through here. Eighteen of
  // them used to call `supabase.auth.getUser()` directly, which skipped the
  // trusted-JWT branch (those endpoints answered 401 to a partner session) and
  // cost a GoTrue round trip each time - several per request on the paths that
  // check membership more than once.
  //
  // The answer is remembered for the life of this repository, which is one
  // request and one access token, so it cannot change underneath a caller.
  // Only a resolved user is remembered: a failed lookup is retried.
  let currentUser: Promise<any> | null = null;
  function getCurrentUser(): Promise<any> {
    if (currentUser) return currentUser;
    const lookup = resolveCurrentUser();
    currentUser = lookup;
    void lookup.then(
      (out) => { if (out?.error || !out?.data?.user?.id) currentUser = null; },
      () => { currentUser = null; },
    );
    return lookup;
  }
  async function resolveCurrentUser() {
    if (!trustedExternalJwtSecret) return supabase.auth.getUser();
    try {
      const user = await verifyTrustedExternalJwt(accessToken, trustedExternalJwtSecret);
      return { data: { user }, error: null };
    } catch (cause) {
      return { data: { user: null }, error: cause };
    }
  }

  /**
   * A `.in(column, ids)` read, split into batches.
   *
   * PostgREST takes its filters in the query string, so a few hundred uuids
   * in one `in` list is a 13 KB URL and the gateway answers `URI too long`
   * — measured on self-host, where the teams list is 352 rows and the screen
   * came back 500 while every unit test passed.
   */
  async function selectInBatches(
    admin: any,
    opts: { schema: string; table: string; select: string; column: string; ids: string[]; eq?: Record<string, unknown> },
  ): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < opts.ids.length; i += IN_FILTER_BATCH) {
      let q = admin
        .schema(opts.schema)
        .from(opts.table)
        .select(opts.select)
        .in(opts.column, opts.ids.slice(i, i + IN_FILTER_BATCH));
      for (const [col, value] of Object.entries(opts.eq ?? {})) q = q.eq(col, value);
      const { data, error } = await q;
      if (error) throw error;
      out.push(...(data ?? []));
    }
    return out;
  }

  /**
   * The caller must be a platform operator of this deployment
   * (platform-operators.ts). Returns their user id, for the audit line.
   *
   * Deliberately independent of every team and org role: an operator acts on
   * teams they do not belong to, and no team role, however high, makes someone
   * an operator.
   */
  async function requirePlatformOperator(): Promise<string> {
    // getCurrentUser, not supabase.auth.getUser: a partner-issued session has no
    // GoTrue session behind it, and an operator may be signed in that way.
    const { data: authData, error: authErr } = await getCurrentUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }
    if (!(await callerIsPlatformOperator(authData.user.id))) {
      throw new ApiError(403, "not_platform_operator", "only platform operators may do this");
    }
    return authData.user.id;
  }

  function callerIsPlatformOperator(userId: string) {
    return resolvePlatformOperator(userId, () => serviceRoleClient("check platform operator"));
  }

  /**
   * The live support grant behind the caller's session, or null: the caller is
   * an org's shared support account (20261108010000) and the JWT's session_id
   * has an unrevoked, unexpired grant.
   */
  async function currentSupportGrant(userId: string) {
    const sessionId = jwtSessionId(accessToken);
    if (!sessionId) return null;
    try {
      const admin = await serviceRoleClient("read support session");
      const { data, error } = await admin
        .schema("amux")
        .rpc("support_session_info", { p_user_id: userId, p_session_id: sessionId });
      if (error) return null;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.grant_id) return null;
      return {
        grantId: String(row.grant_id),
        sessionId,
        orgId: String(row.org_id),
        teamId: row.team_id ? String(row.team_id) : null,
        expiresAt: String(row.expires_at),
      };
    } catch {
      return null;
    }
  }

  async function requireCallerTeamOwner(targetTeamId) {
    const { data: authData, error: authErr } = await getCurrentUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }

    const { data: actor, error: actorErr } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", targetTeamId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (actorErr) throw actorErr;
    if (!actor?.id) {
      throw new ApiError(403, "forbidden", "not a member of this team");
    }

    // Authz SoT is roles_users via current_team_role (not team_members.role).
    const { data: role, error: roleErr } = await supabase.rpc("current_team_role", {
      target_team_id: targetTeamId,
    });
    if (roleErr) throw roleErr;
    if (role !== "owner") {
      throw new ApiError(403, "forbidden", "only team owners may change team share mode");
    }
  }

  async function requireCallerTeamMember(targetTeamId) {
    const { data: authData, error: authErr } = await getCurrentUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }
    const { data: actor, error: actorErr } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", targetTeamId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (actorErr) throw actorErr;
    if (!actor?.id) {
      throw new ApiError(403, "forbidden", "not a member of this team");
    }
  }

  // Like requireCallerTeamMember, but returns the caller's own team-scoped
  // actors.id instead of discarding it. Used by endpoints (e.g.
  // ensureMemberKey) that must resolve "my own actor in this team" — this is
  // intentionally NOT the same as the legacy current_member_id() DB helper,
  // which returns the oldest actor across ALL teams (not team-scoped) and has
  // caused cross-team leakage bugs.
  async function requireCallerTeamMemberActor(targetTeamId) {
    const { data: authData, error: authErr } = await getCurrentUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }
    const { data: actor, error: actorErr } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", targetTeamId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (actorErr) throw actorErr;
    if (!actor?.id) {
      throw new ApiError(403, "forbidden", "not a member of this team");
    }
    return actor.id as string;
  }

  // Escalation hatch for the handful of writes the caller's own token cannot
  // make. `what` is spliced into the misconfiguration error so a missing key
  // says which operation it broke.
  async function serviceRoleClient(what) {
    if (createServiceRoleClientOpt) return createServiceRoleClientOpt();
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!serviceKey) {
      throw new Error(`SUPABASE_SERVICE_ROLE_KEY is not configured on FC; cannot ${what}`);
    }
    const { createServiceRoleClient } = await import("./supabase.js");
    return createServiceRoleClient();
  }

  const forge = forgeFactory({ serviceRoleClient });
  /** An app as `/v1/apps*` answers it: the platform's fields plus the forge's. */
  const appView = (r: any) => mapApp(r, forge.decorate(r));

  function scheduleSessionParticipantsChanged(sessionId: string, removedUserId: string | null = null) {
    if (!publishSessionParticipantInbox) return;
    void publishSessionParticipantsChanged({
      sessionId,
      removedUserId,
      lookup: () => lookupMemberInboxRecipients(supabase, sessionId),
      publish: publishSessionParticipantInbox,
    }).catch((err: unknown) => {
      console.error("[session-participants] notify failed (swallowed):", err);
    });
  }


  async function findAgent(admin, agentId) {
    const { data, error } = await admin
      .from("agents")
      .select("id, owner_member_id")
      .eq("id", agentId)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  // Whether the caller may act on the agent's behalf: it is the agent, owns
  // it, or holds admin on it. `agent` is the `findAgent` row (null when the
  // id names no agent, which only the first case can then satisfy).
  async function callerSpeaksForAgent(admin, callerActorId, agentId, agent) {
    if (callerActorId === agentId) return true;
    if (agent && agent.owner_member_id === callerActorId) return true;
    const { data: grant, error } = await admin
      .from("agent_member_access")
      .select("agent_id")
      .eq("agent_id", agentId)
      .eq("member_id", callerActorId)
      .eq("permission_level", "admin")
      .maybeSingle();
    if (error) throw error;
    return Boolean(grant);
  }

  /**
   * Write an agent's own working state on its seat in a session - the cursor
   * and the model (ADR-0005).
   *
   * `session_participants` has no UPDATE policy, so an update on the caller's
   * token matches nothing; PostgREST reports that as success and the routes
   * answered 204 while the columns stayed frozen. As with
   * `setParticipantWorkspace`, the write goes through the service role after
   * the checks a policy would have made: the caller must see the session and
   * speak for the agent (be it, own it, or hold admin on it). The daemon is
   * the caller in practice and is the agent itself, so the common case costs
   * no agent lookup.
   *
   * 404 when the actor has no seat: a write that changes nothing is the bug
   * this replaces, not a success.
   */
  async function writeAgentSeat(sessionId, actorId, patch, what) {
    const { data: session, error: sessionErr } = await supabase
      .from("sessions")
      .select("id, team_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (sessionErr) throw sessionErr;
    if (!session) throw new ApiError(404, "not_found", "session not found");
    const callerActorId = await requireCallerTeamMemberActor(String(session.team_id));
    const admin = await serviceRoleClient(what);
    if (callerActorId !== actorId) {
      const agent = await findAgent(admin, actorId);
      if (!(await callerSpeaksForAgent(admin, callerActorId, actorId, agent))) {
        throw new ApiError(
          403,
          "forbidden",
          "only the agent, its owner or one of its admins can write its session state",
        );
      }
    }
    const { data: seat, error } = await admin
      .from("session_participants")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("session_id", sessionId)
      .eq("actor_id", actorId)
      .select("actor_id")
      .maybeSingle();
    if (error) throw error;
    if (!seat) throw new ApiError(404, "not_found", "participant not found");
  }


  /** The bearer caller's actor in `teamId`, or null; same lookup as the `resolveCallerActorForTeam` method, for the module hosts below. */
  async function callerActorForTeam(teamId: string): Promise<{ id: string } | null> {
    const { data: userData, error: userErr } = await getCurrentUser();
    if (userErr) throw userErr;
    const userId = userData?.user?.id;
    if (!userId) return null;
    const { data, error } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", teamId)
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? { id: data.id } : null;
  }

  return {
    async authorizeAgentManagement(agentActorId, teamId) {
      if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
      // `list_connected_agents` rather than `actor_directory`: the view's agent
      // predicate is `visibility = 'team' OR owner_member_id = me`, with no
      // agent_member_access clause, so a personal Agent someone granted the
      // caller explicit admin on is invisible there — exactly the Agent the
      // picker offers and this endpoint then 404s on. The RPC is SECURITY
      // DEFINER, carries the `ama.member_id is not null` arm, and computes
      // is_owner / permission_level for the caller in the same pass.
      const { data, error } = await supabase.rpc("list_connected_agents", { p_team_id: teamId });
      if (error) throw error;
      const target = (data ?? []).find((row) => row.agent_id === agentActorId);
      if (!target) throw new ApiError(404, "not_found", "agent not found");
      const requesterActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!requesterActorId) throw new ApiError(403, "forbidden", "team membership required");
      if (target.is_owner !== true && target.permission_level !== "admin") {
        throw new ApiError(403, "forbidden", "agent owner or admin access required");
      }
      return { teamId, requesterActorId };
    },

    async listTeams({ limit = 50 } = {}) {
      // ACTOR-SCOPED "my current teams". RLS (teams_org_guard) already scopes
      // rows to the caller's current org, but an org can contain teams the
      // caller is NOT an actor in (e.g. a mis-provisioned / shared "Personal"
      // org, or a team created by another member). Returning those makes the
      // client adopt a "current team" it can't act on — every team-scoped RPC
      // then fails, most visibly `create_team_invite` ("create_team_invite
      // requires team membership") during daemon onboarding. The SECURITY
      // DEFINER RPC intersects org-scope with the caller's actor membership.
      const { data, error } = await supabase.rpc("list_my_teams_current_org");
      if (error) throw error;
      return (data ?? []).slice(0, limit).map(mapTeam);
    },

    // List the caller's teams across ALL orgs they belong to (cross-org team
    // picker). The `list_all_my_teams` function lives in the `amux` schema and is
    // SECURITY DEFINER (it bypasses teams_org_guard). The default client schema
    // here is `amux`, so it resolves via a plain `.rpc(...)` like create_team etc.
    async listAllMyTeams() {
      // Cross-org team picker source: member teams plus every public team the
      // caller may join. `p_default_org_id` names the shared tenant — the org
      // phone sign-up stamps every account with, which therefore says nothing
      // about belonging and must not contribute its public teams. Same value
      // bootstrapTeam passes as `p_shared_org`; null on a deployment without
      // phone login, where the picker's own-org arm behaves as it always has.
      const { data, error } = await supabase.rpc("list_teams_for_picker", {
        p_default_org_id: process.env.DEFAULT_ORG_ID || null,
        p_include_empty_orgs: false,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.team_id ?? r.org_id,
        name: r.team_name ?? r.org_name,
        slug: r.team_slug ?? null,
        orgId: r.org_id ?? null,
        orgName: r.org_name ?? null,
        visibility: r.visibility ?? "private",
        isMember: r.is_member !== false,
        teamId: r.team_id ?? null,
        // Disambiguation for teams that share a name (an org's teams are all
        // named after the org). Null on an empty-org row, which has no team.
        createdAt: r.created_at ?? null,
        memberCount: typeof r.member_count === "number" ? r.member_count : null,
        ownerName: r.owner_name ?? null,
      }));
    },

    // The org the signed-in identity belongs to, for narrowing the login-time
    // team chooser. `listAllMyTeams` resolves membership phone-wide on purpose
    // (#1340), so without this the account the user just picked — in the phone
    // account picker or the admin console's — decides nothing about which teams
    // they land among.
    //
    // Null when the home org says nothing about belonging: the shared tenant
    // DEFAULT_ORG_ID that phone sign-up stamps on every account, unless the
    // caller is an employee there — the same rule as the picker's
    // `employee_orgs` CTE. Best effort: a lookup failure only means "don't
    // narrow".
    async getHomeOrgId() {
      try {
        const { data: authData, error: authErr } = await getCurrentUser();
        const uid = authData?.user?.id;
        if (authErr || !uid) return null;
        const admin = await serviceRoleClient("resolve the caller's home org");
        const { data, error } = await admin
          .schema("public")
          .from("users")
          .select("org_id, admin_type")
          .eq("id", uid)
          .is("deleted_at", null)
          .maybeSingle();
        if (error || !data?.org_id) return null;
        const sharedOrg = process.env.DEFAULT_ORG_ID || null;
        if (data.org_id === sharedOrg && !isMember(adminTypeOf(data))) return null;
        return data.org_id as string;
      } catch (e) {
        console.warn("getHomeOrgId failed; not narrowing:", (e as Error)?.message ?? e);
        return null;
      }
    },

    // Self-service join of a PUBLIC team. Invoked when
    // the user picks a public team they are not yet a member of. The RPC adds a
    // plain 'member' actor (idempotent if already joined) and rejects anything
    // that is not public.
    async joinPublicTeam(teamId) {
      // `p_default_org_id` names the shared tenant, as in listAllMyTeams: the
      // RPC's own-org check (CS-4) passes for every phone sign-up there, so the
      // shared org needs the extra employee test the picker now applies.
      const { data: caller, error: callerErr } = await getCurrentUser();
      if (callerErr || !caller?.user?.id) {
        throw new ApiError(401, "missing_auth", "authenticated user required");
      }
      const { data, error } = await supabase.rpc("join_public_team", {
        p_team_id: teamId,
        p_default_org_id: process.env.DEFAULT_ORG_ID || null,
      });
      if (error) {
        const code = error?.code || "";
        if (code === "42501") throw new ApiError(403, "forbidden", error.message ?? "team is not joinable");
        if (code === "P0002") throw new ApiError(404, "not_found", error.message ?? "team not found");
        throw error;
      }
      const row = requiredRow(data, "teams.joinPublicTeam");
      const joinedTeamId = requiredString(row.team_id ?? row.id, "teams.joinPublicTeam", "team_id");
      // Honour the role the RPC returned. `join_public_team` is idempotent and
      // reports 'owner' for a caller who already owns this team; hardcoding
      // 'member' mirrored that owner back down in team_members.role — the
      // column remove_team_actor's last-owner guard still reads.
      const joinedRole =
        typeof row.role === "string" && row.role.trim() ? row.role.trim() : "member";
      const admin = await serviceRoleClient("assign org role on public team join");
      await assignSystemOrgRole(admin, {
        teamId: joinedTeamId,
        userId: caller.user.id,
        code: joinedRole,
      });
      // A new teammate reads the team's team-visible apps through its Gitea team.
      await forge.teamAccessChanged(joinedTeamId);
      return mapTeam({
        id: joinedTeamId,
        name: row.team_name ?? row.name,
        slug: row.team_slug ?? row.slug,
      });
    },

    // Owner/member-scoped visibility toggle (public | private) for a default-org
    // team, driven by PATCH /v1/teams/:id. RLS on amux.teams gates the write to
    // team members.
    async setTeamVisibility(teamId, { visibility }) {
      if (visibility !== "public" && visibility !== "private") {
        throw new ApiError(400, "validation_failed", "visibility must be 'public' or 'private'");
      }
      const { data, error } = await supabase
        .schema("amux")
        .from("teams")
        .update({ visibility })
        .eq("id", teamId)
        .select(TEAM_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "not_found", "team not found");
      return mapTeam(data);
    },

    async createTeam(input) {
      // Explicit creation. Login onboarding calls bootstrapTeam below instead;
      // this path never silently joins an existing organization team.
      //
      // Org resolution is JWT app_metadata.org_id → lazily provisioned personal
      // org. DEFAULT_ORG_ID is deliberately NOT in this chain any more: it used
      // to drop every org-less signup into one shared tenant, which is exactly
      // the behaviour this redesign removes. It now serves phone-auth only.
      const { data: caller, error: callerErr } = await getCurrentUser();
      if (callerErr || !caller?.user?.id) {
        throw new ApiError(401, "missing_auth", "authenticated user required");
      }
      let fallbackOrg: string | null =
        (caller.user.app_metadata as any)?.org_id ?? null;
      if (!fallbackOrg) {
        // Same switch as the bootstrap path: minting an org IS self-registration.
        assertNewOrgAllowed();
        // The team name names the new org too (the iOS create-team screen is
        // this path) — one name for both, as bootstrap does.
        const { data: provisioned, error: orgErr } =
          await supabase.rpc("ensure_personal_org", { p_name: input.name ?? null });
        if (orgErr) throw orgErr;
        fallbackOrg = (provisioned as string | null) ?? null;
      }
      const { data, error } = await supabase.rpc("create_team", {
        p_name: input.name ?? null,
        p_slug: input.slug ?? null,
        p_display_name: input.displayName ?? null,
        // Still on create_team's signature; the AI gateway is configured
        // per-team via setLlmConfig instead, so these are always null.
        p_litellm_team_id: null,
        p_ai_gateway_endpoint: null,
        p_oid: fallbackOrg,
      });
      if (error) throw error;
      const row = requiredRow(data, "teams.createTeam");
      const teamId = requiredString(row.team_id ?? row.id, "teams.createTeam", "team_id");
      // roles_users is the authz source of truth; creator gets owner (Task 4).
      // Service-role: caller JWT cannot INSERT (is_org_role_manager chicken-egg).
      const admin = await serviceRoleClient("assign owner org role on team create");
      await assignSystemOrgRole(admin, {
        teamId,
        userId: caller.user.id,
        code: "owner",
      });
      return mapTeam({
        id: teamId,
        name: row.team_name ?? row.name,
        slug: row.team_slug ?? row.slug,
        created_at: row.created_at ?? null,
      });
    },

    // Login onboarding. The whole decision — which org, create one or not,
    // create the org's default team or join it — lives in a single SQL
    // orchestrator so it happens in one transaction; letting FC read the org
    // first and then pick an RPC would add a round trip and a race window.
    //
    //   no org        → mint one (named after the caller) + its public default team
    //   shared tenant → today's path (own private team); see p_shared_org below
    //   real org      → ensure the org's public default team, join it
    async bootstrapTeam(input) {
      const { data: caller, error: callerErr } = await getCurrentUser();
      if (callerErr || !caller?.user?.id) {
        throw new ApiError(401, "missing_auth", "authenticated user required");
      }
      const teamName =
        typeof input?.teamName === "string" && input.teamName.trim()
          ? input.teamName.trim()
          : null;
      const { data, error } = await supabase.rpc("bootstrap_login_team", {
        // FC-layer enforcement, deliberately. See FeatureFlags.allowNewOrg.
        p_allow_new_org: newOrgAllowed(),
        // The partner tenant is frozen on the old behaviour: phone-auth stamps
        // this org, and without the exclusion belayo's phone users would all be
        // funnelled into one shared default team.
        p_shared_org: process.env.DEFAULT_ORG_ID || null,
        p_display_name: input?.displayName ?? null,
        // Names the org and its default team. Null keeps the old derivation
        // (nickname → OAuth full name → email local part), so an older client
        // that does not send it behaves exactly as before.
        p_team_name: teamName,
      });
      if (error) {
        if (error.code === "42501" && /self-registration is disabled/i.test(error.message ?? "")) {
          throw new ApiError(
            403,
            "registration_disabled",
            "self-registration is disabled on this deployment",
          );
        }
        throw error;
      }
      const row = requiredRow(data, "teams.bootstrapTeam");
      const teamId = requiredString(row.team_id ?? row.id, "teams.bootstrapTeam", "team_id");
      // Use the role the orchestrator returned, never a hardcoded 'owner'.
      // `ensure_org_public_team` JOINS the caller into an org's EXISTING public
      // team as a plain member and says so (role='member'); only its create
      // branch reports 'owner'. Granting owner unconditionally made the second
      // and every later employee an owner of the org — and, because roles_users
      // is org-scoped, of every team under it.
      // Service-role: same chicken-egg as createTeam (roles_users RLS).
      const bootstrapRole =
        typeof row.role === "string" && row.role.trim() ? row.role.trim() : "member";
      const admin = await serviceRoleClient("assign org role on team bootstrap");
      await assignSystemOrgRole(admin, {
        teamId,
        userId: caller.user.id,
        code: bootstrapRole,
      });
      return mapTeam({ id: teamId, name: row.team_name ?? row.name, slug: row.team_slug ?? row.slug });
    },

    async getTeam(teamId) {
      const { data, error } = await supabase
        .from("teams")
        .select(`${TEAM_COLUMNS}, oid`)
        .eq("id", teamId)
        .single();
      if (error) throw error;
      // Resolve the org name with an explicit lookup instead of a PostgREST
      // embed (`orgs:oid(name)`). The teams→orgs FK crosses schemas
      // (amux.teams.oid → public.orgs.id); PostgREST's cross-schema relationship
      // inference is not reliably present in the self-host schema cache, which
      // surfaced as PGRST200 "Could not find a relationship between 'teams' and
      // 'oid'". A direct query against public.orgs works on both prod and
      // self-host.
      let orgs: { name: string } | null = null;
      if (data?.oid) {
        const { data: org } = await supabase
          .schema("public")
          .from("orgs")
          .select("name")
          .eq("id", data.oid)
          .maybeSingle();
        orgs = org ?? null;
      }
      return mapTeam({ ...data, orgs });
    },

    async renameTeam(teamId, { name }) {
      const { data, error } = await supabase.rpc("rename_team", { p_team_id: teamId, p_name: name });
      if (error) throw error;
      return mapTeam(requiredRow(data, "teams.renameTeam"));
    },

    // Account upgrade: graduate the caller out of the shared DEFAULT_ORG into
    // their own org (create org + reparent/rename their team). See
    // docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md §8.
    async upgradeAccount({ teamId, orgName, contact }) {
      const defaultOrgId = process.env.DEFAULT_ORG_ID || null;
      const { data, error } = await supabase.rpc("upgrade_account_to_org", {
        p_team_id: teamId,
        p_org_name: orgName,
        p_contact: contact ?? null,
        p_default_org_id: defaultOrgId,
      });
      if (error) {
        const code = error?.code || "";
        if (code === "42501") throw new ApiError(403, "forbidden", error.message ?? "not allowed");
        if (code === "23514") throw new ApiError(400, "validation_failed", error.message ?? "invalid upgrade");
        throw new ApiError(400, "validation_failed", error.message ?? "upgrade failed");
      }
      const row = requiredRow(data, "account.upgradeAccount");
      return {
        orgId: requiredString(row.org_id, "account.upgradeAccount", "org_id"),
        teamId: requiredString(row.team_id, "account.upgradeAccount", "team_id"),
        teamName: requiredString(row.team_name, "account.upgradeAccount", "team_name"),
      };
    },

    async getTeamJoinLink(teamId) {
      const { data, error } = await supabase.rpc("get_team_join_link", { p_team_id: teamId });
      if (error) mapJoinLinkAdminError(error);
      return mapTeamJoinLinkRow(requiredRow(data, "teams.getTeamJoinLink"));
    },

    async putTeamJoinLink(teamId, input) {
      // The RPC does not return `created`. Compute it in FC: missing unrevoked
      // row (404) or rotate=true → 201. A race between get and put is acceptable.
      let created = input.rotate === true;
      const existing = await supabase.rpc("get_team_join_link", { p_team_id: teamId });
      if (existing.error) {
        try {
          mapJoinLinkAdminError(existing.error);
        } catch (err) {
          if (!(err instanceof ApiError && err.statusCode === 404)) throw err;
          created = true;
        }
      }
      const { data, error } = await supabase.rpc("put_team_join_link", {
        p_team_id: teamId,
        p_ttl: input.ttl,
        p_max_uses: input.maxUses ?? null,
        p_rotate: input.rotate === true,
        p_default_org_id: process.env.DEFAULT_ORG_ID || null,
      });
      if (error) mapJoinLinkAdminError(error);
      return { ...mapTeamJoinLinkRow(requiredRow(data, "teams.putTeamJoinLink")), created };
    },

    async revokeTeamJoinLink(teamId) {
      const { error } = await supabase.rpc("revoke_team_join_link", { p_team_id: teamId });
      if (error) mapJoinLinkAdminError(error);
    },

    async createTeamInvite(teamId, input) {
      // Default-org teams are solo-only: a personal team sitting in the shared
      // DEFAULT_ORG cannot pull in members. The user must first upgrade their
      // account (which moves the team into their own org). Agent invites (the
      // daemon's amuxd init) are still allowed so local runtimes work.
      const defaultOrgId = process.env.DEFAULT_ORG_ID || "";
      if (defaultOrgId && input.kind === "member") {
        const { data: team } = await supabase
          .schema("amux")
          .from("teams")
          .select("oid")
          .eq("id", teamId)
          .maybeSingle();
        if (team?.oid === defaultOrgId) {
          throw new ApiError(
            403,
            "upgrade_required",
            "升级账号后才能邀请成员加入团队",
          );
        }
      }
      const args: any = {
        p_team_id: teamId,
        p_kind: input.kind,
        p_display_name: input.displayName,
      };
      if (input.teamRole != null) args.p_team_role = input.teamRole;
      if (input.agentKind != null) args.p_agent_kind = input.agentKind;
      if (input.ttlSeconds != null) args.p_ttl_seconds = input.ttlSeconds;
      if (input.targetActorId != null) args.p_target_actor_id = input.targetActorId;
      if (input.inviteEmail != null) args.p_invite_email = input.inviteEmail;
      if (input.invitePhone != null) args.p_invite_phone = input.invitePhone;
      const { data, error } = await supabase.rpc("create_team_invite", args);
      if (error) {
        // 22023 covers the RPC's own argument validation (bad email shape, a
        // digitless phone, contact on an agent invite) — a client mistake, not
        // a server fault, so surface it as 400 rather than a raw 500.
        if (error.code === "22023") {
          throw new ApiError(400, "validation_failed", error.message ?? "invalid invite");
        }
        throw error;
      }
      const row = requiredRow(data, "teams.createTeamInvite");
      return {
        token: requiredString(row.token, "teams.createTeamInvite", "token"),
        expiresAt: row.expires_at ?? null,
        deeplink: row.deeplink ?? null,
      };
    },

    async removeTeamActor(_teamId, actorId) {
      // Read the team before the actor is gone: the removal cascades their app
      // grants away, and Gitea has to drop the same access.
      let teamId: string | null = _teamId ?? null;
      if (!teamId) {
        const { data: actorRow } = await supabase.from("actors").select("team_id").eq("id", actorId).maybeSingle();
        teamId = actorRow?.team_id ?? null;
      }
      // Explicit amux schema: client default is already amux, but keep this
      // belt-and-suspenders so we never resolve a stale public.remove_team_actor.
      const { error } = await supabase
        .schema("amux")
        .rpc("remove_team_actor", { p_actor_id: actorId });
      if (error) throw error;
      if (teamId) await forge.teamAccessChanged(teamId);
    },

    async updateCurrentActorProfile(actorId, { displayName, avatarUrl }) {
      const { data, error } = await supabase.rpc("update_current_actor_profile", {
        p_actor_id: actorId,
        p_display_name: displayName,
        p_avatar_url: avatarUrl ?? null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return mapDirectoryActor(row);
    },

    async getMemberDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_member_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      // RPC returns a scalar uuid (or null).
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async setMemberDefaultAgent(teamId, agentId) {
      const { data, error } = await supabase.rpc("set_member_default_agent", {
        p_team_id: teamId,
        p_agent_id: agentId ?? null,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async getTeamDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_team_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async setTeamDefaultAgent(teamId, agentId) {
      const { data, error } = await supabase.rpc("set_team_default_agent", {
        p_team_id: teamId,
        p_agent_id: agentId ?? null,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async getEffectiveDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_effective_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async reportClientVersion(teamId, body) {
      const { error } = await supabase.rpc("report_client_version", {
        p_team_id: teamId,
        p_client_type: body.clientType,
        p_version: body.version,
        p_device_id: body.deviceId,
        p_build: body.build ?? null,
      });
      if (error) throw error;
    },


    async getWorkspaceConfig(teamId) {
      const { data: configData, error: configError } = await supabase
        .from("team_workspace_config")
        .select("sync_mode, litellm_team_id, llm_enabled, llm_base_url, llm_models")
        .eq("team_id", teamId)
        .maybeSingle();
      if (configError) throw configError;
      const configRes = { data: configData };
      const storedModels = Array.isArray(configRes.data?.llm_models) ? configRes.data.llm_models : [];
      return {
        syncMode: configRes.data?.sync_mode ?? null,
        // Nothing provisions this any more, but it is still RETURNED (null where
        // absent) so already-shipped desktop and iOS builds keep parsing the
        // response — they do not update in lockstep with the server. Dropping it
        // from the payload is gated on the minimum supported client, not on this
        // change. See MergedWorkspaceConfig in the OpenAPI contract.
        litellmTeamId: configRes.data?.litellm_team_id ?? null,
        llm: {
          enabled: configRes.data?.llm_enabled ?? false,
          baseUrl: configRes.data?.llm_base_url ?? null,
          models: storedModels,
        },
      };
    },

    async setLlmConfig(teamId, input) {
      // Every agent in the team sends its prompts to this baseUrl, so only an
      // owner or admin may change it. The table's write policies say the same
      // (20261119130000); this check answers 403 instead of an RLS error.
      await this.requireTeamAdmin(teamId);
      const { error } = await supabase
        .from("team_workspace_config")
        .upsert(
          {
            team_id: teamId,
            llm_enabled: input.enabled,
            llm_base_url: input.baseUrl,
            llm_models: input.models,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "team_id" },
        );
      if (error) throw error;
      return {
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        models: input.models,
      };
    },

    // ── team credits ────────────────────────────────────────────────────────
    // Every read and write goes through the AI gateway rather than these tables
    // directly: it is the ledger's only writer (design §4.9.1), and routing reads
    // the same way keeps period boundaries and shapes identical on both sides of
    // the billing screen.
    //
    // Permission split per §12.6: balance and usage are visible to every member
    // — an exhausted wallet stops their work, so they must be able to see why —
    // while the ledger and every mutation are owner-only.
    //
    // These are restored, not new. They were adjacent to the LiteLLM block that
    // `feat(fc)!: remove LiteLLM token-usage reporting` deleted, and went with
    // it, leaving `routes/team-credits.ts` calling eight methods no repository
    // implemented: every credits and quota endpoint answered
    // `ctx.repository.<method> is not a function`. Both that file and this one
    // kept importing `aiGateway` without using it, which is what the deletion
    // left behind.
    async getTeamCredits(teamId: string) {
      await requireCallerTeamMember(teamId);
      const [summary, usage] = await Promise.all([
        aiGateway.creditsSummary(teamId),
        aiGateway.usage(teamId, { range: "month" }),
      ]);
      return {
        teamId,
        balanceCredits: summary.balanceCredits ?? 0,
        period: { range: usage.range, startUtc: usage.startUtc, endUtc: usage.endUtc },
        usedCredits: usage.summary?.credits ?? 0,
      };
    },
    async getCreditUsage(teamId: string, opts: { range?: string; date?: string } = {}) {
      await requireCallerTeamMember(teamId);
      return aiGateway.usage(teamId, opts);
    },
    async getCreditLedger(teamId: string, opts: { limit?: number } = {}) {
      await requireCallerTeamOwner(teamId);
      return aiGateway.ledger(teamId, opts.limit);
    },
    async topUpCredits(teamId: string, input: any) {
      // Operators only. This used to be owner-only, and every self-registered
      // user owns the team they create — so any account could mint itself
      // credits for nothing. Paid top-ups do not come through here at all:
      // the Stripe webhook calls the gateway directly (routes/stripe.ts).
      const operatorId = await requirePlatformOperator();
      const amount = Number(input?.amountCredits);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new ApiError(400, "invalid_request", "amountCredits must be a positive integer");
      }
      // Required rather than generated here: an idempotency key the server
      // invents is a new key on every retry, which defeats the point.
      if (!input?.idempotencyKey) {
        throw new ApiError(400, "invalid_request", "idempotencyKey is required");
      }
      const result = await aiGateway.topUp(teamId, {
        amountCredits: amount,
        kind: input.kind ?? "top_up",
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
      });
      // Who granted what. Not in the ledger note, which the team owner reads.
      console.log(
        `[admin] operator ${operatorId} credited team ${teamId}: ${amount} (${input.kind ?? "top_up"}, ` +
          `key ${input.idempotencyKey}, applied=${result?.applied})`,
      );
      return result;
    },

    // ── platform operators ──────────────────────────────────────────────────
    // Answers for ANY signed-in caller: whether they are an operator, and their
    // user id — which is what goes into PLATFORM_OPERATOR_USER_IDS. The client
    // shows the operator screens only when `operator` is true; every operator
    // endpoint checks again on its own.
    async getAdminWhoami() {
      const { data: authData, error: authErr } = await getCurrentUser();
      if (authErr || !authData?.user?.id) {
        throw new ApiError(401, "missing_auth", "authenticated user required");
      }
      const userId = authData.user.id;
      const [operator, grant] = await Promise.all([
        callerIsPlatformOperator(userId),
        currentSupportGrant(userId),
      ]);
      return {
        userId,
        operator,
        support: grant ? { orgId: grant.orgId, teamId: grant.teamId, expiresAt: grant.expiresAt } : null,
      };
    },

    /**
     * A platform operator enters `teamId` of customer org `orgId` as that
     * org's shared support account (amux.start_support_session). Returns a
     * refresh token for a session of its own — one per entry, so operators
     * sharing the account are told apart and revoked one by one.
     *
     * The client keeps the operator's own session and returns to it on exit;
     * there is deliberately no endpoint that turns a support session back into
     * the operator's, or holding one would be holding operator rights.
     */
    async startSupportSession(orgId: string, input: { teamId?: unknown; reason?: unknown; ttlMinutes?: unknown } = {}) {
      const operatorId = await requirePlatformOperator();
      const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (!teamId) throw new ApiError(400, "validation_failed", "teamId is required");
      if (!reason) throw new ApiError(400, "validation_failed", "reason is required");
      if (reason.length > 500) throw new ApiError(400, "validation_failed", "reason is at most 500 characters");
      let ttlMinutes = 240;
      if (input.ttlMinutes !== undefined && input.ttlMinutes !== null) {
        ttlMinutes = Math.trunc(Number(input.ttlMinutes));
        if (!Number.isFinite(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 24 * 60) {
          throw new ApiError(400, "validation_failed", "ttlMinutes must be between 5 and 1440");
        }
      }

      const admin = await serviceRoleClient("start a support session");
      const { data: team, error: teamErr } = await admin
        .schema("amux").from("teams").select("id,oid").eq("id", teamId).maybeSingle();
      if (teamErr) throw teamErr;
      if (!team || team.oid !== orgId) throw new ApiError(404, "not_found", "team not found in this org");

      const { data, error } = await admin.schema("amux").rpc("start_support_session", {
        p_operator_user_id: operatorId,
        p_team_id: teamId,
        p_reason: reason,
        p_ttl: `${ttlMinutes} minutes`,
      });
      if (error) {
        const code = error.code || "";
        if (code === "42501") throw new ApiError(403, "not_platform_operator", "only platform operators may do this");
        if (code === "P0002") throw new ApiError(404, "not_found", error.message ?? "team not found");
        if (code === "22023") throw new ApiError(400, "validation_failed", error.message ?? "invalid support session");
        throw error;
      }
      const row = requiredRow(Array.isArray(data) ? data[0] : data, "admin.startSupportSession");
      // Who went where and why. support_grants has it too; the log is where
      // the other operator lines already are.
      console.log(
        `[admin] operator ${operatorId} entered org ${row.org_id} team ${row.team_id} ` +
          `as support (grant ${row.grant_id}, until ${row.expires_at})`,
      );
      return {
        grantId: requiredString(row.grant_id, "admin.startSupportSession", "grant_id"),
        refreshToken: requiredString(row.refresh_token, "admin.startSupportSession", "refresh_token"),
        orgId: requiredString(row.org_id, "admin.startSupportSession", "org_id"),
        teamId: requiredString(row.team_id, "admin.startSupportSession", "team_id"),
        actorId: requiredString(row.actor_id, "admin.startSupportSession", "actor_id"),
        supportUserId: requiredString(row.support_user_id, "admin.startSupportSession", "support_user_id"),
        expiresAt: requiredString(row.expires_at, "admin.startSupportSession", "expires_at"),
      };
    },

    /**
     * Ends the support session the caller is using: its auth session and
     * refresh tokens are deleted, the grant row stays as the record.
     * `ended: false` when the caller is not in a live support session.
     */
    async endCurrentSupportSession() {
      const { data: authData, error: authErr } = await getCurrentUser();
      if (authErr || !authData?.user?.id) {
        throw new ApiError(401, "missing_auth", "authenticated user required");
      }
      const sessionId = jwtSessionId(accessToken);
      if (!sessionId) return { ended: false };
      const admin = await serviceRoleClient("end a support session");
      const { data, error } = await admin
        .schema("amux")
        .rpc("end_support_session", { p_user_id: authData.user.id, p_session_id: sessionId });
      if (error) throw error;
      return { ended: data === true };
    },

    /**
     * Orgs of this deployment, newest first, with how many teams and people
     * are in each.
     *
     * Service-role reads: an operator is not a member of what they are looking
     * at, so RLS would hide almost all of it. Counts come from separate
     * queries rather than a join — PostgREST's cross-schema relationship
     * inference (amux.teams → public.orgs) is not reliably in the self-host
     * schema cache, which surfaces as PGRST200.
     */
    async listAdminOrgs(opts: { query?: string; limit?: number; offset?: number } = {}) {
      await requirePlatformOperator();
      const admin = await serviceRoleClient("list orgs for the operator console");
      const limit = clampPage(opts.limit, 25);
      const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)) || 0);
      const search = safeSearch(opts.query);

      let q = admin
        .schema("public")
        .from("orgs")
        .select("id,name,code,status,created_at", { count: "exact" });
      if (search) q = q.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
      const { data, error, count } = await q
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      const orgs = data ?? [];
      const orgIds = orgs.map((o: any) => o.id);

      const counts = new Map<string, { teams: number; members: Set<string> }>();
      if (orgIds.length) {
        const teams = await selectInBatches(admin, {
          schema: "amux", table: "teams", select: "id,oid", column: "oid", ids: orgIds,
        });
        const teamOrg = new Map<string, string>();
        for (const t of teams) {
          teamOrg.set(t.id, t.oid);
          const c = counts.get(t.oid) ?? { teams: 0, members: new Set<string>() };
          c.teams++;
          counts.set(t.oid, c);
        }
        const teamIds = [...teamOrg.keys()];
        if (teamIds.length) {
          const actors = await selectInBatches(admin, {
            schema: "amux", table: "actors", select: "team_id,user_id,actor_type",
            column: "team_id", ids: teamIds, eq: { actor_type: "member" },
          });
          for (const a of actors) {
            const oid = teamOrg.get(a.team_id);
            if (!oid || !a.user_id) continue;
            counts.get(oid)?.members.add(a.user_id);
          }
        }
      }

      return {
        items: orgs.map((o: any) => ({
          id: o.id,
          name: o.name,
          code: o.code ?? null,
          status: o.status ?? null,
          createdAt: o.created_at,
          teamCount: counts.get(o.id)?.teams ?? 0,
          memberCount: counts.get(o.id)?.members.size ?? 0,
        })),
        total: count ?? orgs.length,
      };
    },

    /**
     * Rename an org, or take it out of service.
     *
     * Only `name` and `status`, deliberately: on Belayo this table is shared
     * with saas-mono, which owns every other column. `updated_by` is NOT set
     * here — the table's audit trigger overwrites it with `auth.uid()`, which
     * is null under the service role — so who did it goes in `updated_note`
     * and in the log line.
     */
    async updateAdminOrg(orgId: string, patch: { name?: string; status?: string }) {
      const operatorId = await requirePlatformOperator();
      if (!/^[0-9a-f-]{36}$/i.test(orgId)) {
        throw new ApiError(400, "invalid_request", "orgId must be a uuid");
      }
      const update: Record<string, unknown> = {};
      if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (!name || name.length > 100) {
          throw new ApiError(400, "invalid_request", "name must be 1-100 characters");
        }
        update.name = name;
      }
      if (patch.status !== undefined) {
        // The column has no CHECK, and saas-mono owns the vocabulary on Belayo.
        // Writing only the two values this product uses elsewhere (org roles)
        // keeps the console from inventing a third.
        if (patch.status !== "active" && patch.status !== "inactive") {
          throw new ApiError(400, "invalid_request", 'status must be "active" or "inactive"');
        }
        update.status = patch.status;
      }
      if (!Object.keys(update).length) {
        throw new ApiError(400, "invalid_request", "nothing to update");
      }
      update.updated_note = `platform operator ${operatorId} via console`;

      const admin = await serviceRoleClient("update an org from the operator console");
      const { data, error } = await admin
        .schema("public")
        .from("orgs")
        .update(update)
        .eq("id", orgId)
        .select("id,name,code,status,created_at")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "not_found", "no such org");
      console.log(`[admin] operator ${operatorId} updated org ${orgId}: ${JSON.stringify(update)}`);
      return {
        id: data.id,
        name: data.name,
        code: data.code ?? null,
        status: data.status ?? null,
        createdAt: data.created_at,
      };
    },

    /**
     * Teams of this deployment with their balance and this month's spend.
     *
     * Read whole and sorted here rather than paged in the database: the sort
     * key an operator wants is the balance, which lives in the gateway, so no
     * database page can be ordered by it. Capped at `ADMIN_LIST_CAP`, and
     * `truncated` says when the cap cut the list.
     */
    async listAdminTeams(
      opts: { query?: string; orgId?: string; sort?: string; limit?: number; offset?: number } = {},
    ) {
      await requirePlatformOperator();
      const admin = await serviceRoleClient("list teams for the operator console");
      const limit = clampPage(opts.limit, 25);
      const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)) || 0);
      const search = safeSearch(opts.query);

      let q = admin.schema("amux").from("teams").select("id,slug,name,created_at,oid");
      if (opts.orgId) {
        if (!/^[0-9a-f-]{36}$/i.test(opts.orgId)) {
          throw new ApiError(400, "invalid_request", "orgId must be a uuid");
        }
        q = q.eq("oid", opts.orgId);
      }
      if (search) q = q.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
      const { data, error } = await q.order("created_at", { ascending: false }).range(0, ADMIN_LIST_CAP - 1);
      if (error) throw error;
      const teams = data ?? [];
      const truncated = teams.length >= ADMIN_LIST_CAP;

      const [orgNames, memberCounts, totals] = await Promise.all([
        (async () => {
          const ids = [...new Set(teams.map((t: any) => t.oid).filter(Boolean))] as string[];
          if (!ids.length) return new Map<string, string>();
          const orgs = await selectInBatches(admin, {
            schema: "public", table: "orgs", select: "id,name", column: "id", ids,
          });
          return new Map(orgs.map((o: any) => [o.id as string, o.name as string]));
        })(),
        (async () => {
          const ids = teams.map((t: any) => t.id) as string[];
          const counts = new Map<string, number>();
          if (!ids.length) return counts;
          const actors = await selectInBatches(admin, {
            schema: "amux", table: "actors", select: "team_id", column: "team_id", ids,
            eq: { actor_type: "member" },
          });
          for (const a of actors) counts.set(a.team_id, (counts.get(a.team_id) ?? 0) + 1);
          return counts;
        })(),
        // The gateway owns the ledger, so the money numbers come from it even
        // for a read (design §4.9.1) — FC never reads those tables directly.
        aiGateway.creditTeams(ADMIN_LIST_CAP).catch(() => ({ items: [], truncated: false })),
      ]);

      const credits = new Map<string, { balanceCredits: number; periodCredits: number }>(
        (totals?.items ?? []).map((i: any) => [i.teamId, i]),
      );
      const rows = teams.map((t: any) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        orgId: t.oid ?? null,
        orgName: t.oid ? orgNames.get(t.oid) ?? null : null,
        createdAt: t.created_at,
        memberCount: memberCounts.get(t.id) ?? 0,
        balanceCredits: credits.get(t.id)?.balanceCredits ?? 0,
        periodCredits: credits.get(t.id)?.periodCredits ?? 0,
      }));
      if (opts.sort === "balance") {
        // "About to run dry" is the question this sort answers, and a team the
        // ledger has never heard of (no balance, nothing spent) is not about to
        // run dry — it has never had credits. Measured on self-host, where such
        // teams are most of the table and filled the whole first page.
        const known = (r: { balanceCredits: number; periodCredits: number }) =>
          r.balanceCredits !== 0 || r.periodCredits !== 0;
        rows.sort((a, b) => {
          if (known(a) !== known(b)) return known(a) ? -1 : 1;
          return a.balanceCredits - b.balanceCredits;
        });
      } else if (opts.sort === "usage") {
        rows.sort((a, b) => b.periodCredits - a.periodCredits);
      }

      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        truncated: truncated || Boolean(totals?.truncated),
      };
    },

    /** One team's money: balance, this month, the top-up history and the limits. */
    async getAdminTeamCredits(teamId: string) {
      await requirePlatformOperator();
      if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
        throw new ApiError(400, "invalid_request", "teamId must be a uuid");
      }
      const admin = await serviceRoleClient("read a team for the operator console");
      const [summary, usage, ledger, quotas, team, actors] = await Promise.all([
        aiGateway.creditsSummary(teamId),
        aiGateway.usage(teamId, { range: "month" }),
        aiGateway.ledger(teamId, 20),
        aiGateway.quotas(teamId),
        admin.schema("amux").from("teams").select("id,slug,name,oid,created_at").eq("id", teamId).maybeSingle(),
        admin.schema("amux").from("actors").select("id,display_name,actor_type").eq("team_id", teamId),
      ]);
      if (team.error) throw team.error;
      if (!team.data) throw new ApiError(404, "not_found", "no such team");
      if (actors.error) throw actors.error;

      let orgName: string | null = null;
      if (team.data.oid) {
        const { data: org } = await admin
          .schema("public")
          .from("orgs")
          .select("name")
          .eq("id", team.data.oid)
          .maybeSingle();
        orgName = org?.name ?? null;
      }
      const names = new Map<string, { display_name: string | null; actor_type: string | null }>(
        (actors.data ?? []).map((a: any) => [a.id as string, a]),
      );

      return {
        team: {
          id: team.data.id,
          slug: team.data.slug,
          name: team.data.name,
          orgId: team.data.oid ?? null,
          orgName,
          createdAt: team.data.created_at,
        },
        balanceCredits: summary?.balanceCredits ?? 0,
        usage,
        ledger: ledger?.items ?? [],
        quotas: {
          period: quotas?.period ?? "month",
          defaultLimitCredits: quotas?.defaultLimitCredits ?? null,
          lowBalanceCredits: quotas?.lowBalanceCredits ?? null,
          members: (quotas?.members ?? []).map((m: any) => ({
            actorId: m.actorId,
            displayName: names.get(m.actorId)?.display_name ?? null,
            actorType: names.get(m.actorId)?.actor_type ?? null,
            limitCredits: m.limitCredits,
          })),
        },
        actors: (actors.data ?? []).map((a: any) => ({
          id: a.id,
          displayName: a.display_name,
          actorType: a.actor_type,
        })),
      };
    },

    /** The team's period, its default member limit and any per-member limits. */
    async setAdminTeamQuotas(teamId: string, input: any) {
      const operatorId = await requirePlatformOperator();
      if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
        throw new ApiError(400, "invalid_request", "teamId must be a uuid");
      }
      if (input?.period !== undefined && input.period !== "week" && input.period !== "month") {
        throw new ApiError(400, "invalid_request", 'period must be "week" or "month"');
      }
      for (const field of ["defaultLimitCredits", "lowBalanceCredits"] as const) {
        const v = input?.[field];
        if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || v < 0)) {
          throw new ApiError(400, "invalid_request", `${field} must be a non-negative integer or null`);
        }
      }
      for (const m of input?.members ?? []) {
        if (!/^[0-9a-f-]{36}$/i.test(String(m?.actorId ?? ""))) {
          throw new ApiError(400, "invalid_request", "each member needs an actorId");
        }
        if (m.limitCredits !== null && (!Number.isSafeInteger(m.limitCredits) || m.limitCredits < 0)) {
          throw new ApiError(400, "invalid_request", "limitCredits must be a non-negative integer or null");
        }
      }
      const result = await aiGateway.setQuotas(teamId, {
        period: input?.period,
        defaultLimitCredits: input?.defaultLimitCredits ?? null,
        lowBalanceCredits: input?.lowBalanceCredits ?? null,
        members: input?.members ?? [],
      });
      console.log(
        `[admin] operator ${operatorId} set quotas on team ${teamId}: ` +
          `period=${input?.period ?? "unchanged"} default=${input?.defaultLimitCredits ?? "null"} ` +
          `low=${input?.lowBalanceCredits ?? "null"} members=${(input?.members ?? []).length}`,
      );
      return result;
    },

    // The AI gateway's provider keys: which serve, which are benched and why.
    // Passed through as the gateway reports it — the shape is the gateway's,
    // and a copy here would drift from it.
    async getProviderPools() {
      await requirePlatformOperator();
      return aiGateway.providerPools();
    },

    // Put benched keys back into service now — after funding an account, rather
    // than waiting out the backoff. `keyId` narrows it to one key.
    async resetProviderPool(providerId: string, input: any) {
      const operatorId = await requirePlatformOperator();
      // Checked here rather than left to the gateway: path params arrive raw,
      // and a provider id is a catalog slug, never anything that needs escaping.
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(providerId)) {
        throw new ApiError(400, "invalid_request", "providerId must be a catalog provider id");
      }
      const keyId = input?.keyId;
      if (keyId !== undefined && (typeof keyId !== "string" || !/^[0-9a-f]{8}$/.test(keyId))) {
        throw new ApiError(400, "invalid_request", "keyId must be a key id from the pool listing");
      }
      const result = await aiGateway.resetProviderPool(providerId, keyId);
      console.log(
        `[admin] operator ${operatorId} reset provider pool ${providerId}` +
          `${keyId ? ` key ${keyId}` : ""}: cleared ${result?.cleared}`,
      );
      return result;
    },
    async listCreditPackages(teamId: string) {
      await requireCallerTeamMember(teamId);
      // Resolves to the `./stripe.js` import, not to this method: a property of
      // an object literal is not in scope inside its own body.
      return { items: await listCreditPackages() };
    },
    async createCreditCheckoutSession(teamId: string, input: any) {
      await requireCallerTeamOwner(teamId);
      const priceId = String(input?.priceId ?? "").trim();
      if (!priceId) {
        throw new ApiError(400, "invalid_request", "priceId is required");
      }
      return createCheckoutSession({ teamId, priceId });
    },
    async getMemberQuotas(teamId: string) {
      await requireCallerTeamMember(teamId);
      return aiGateway.quotas(teamId);
    },
    async setMemberQuotas(teamId: string, input: any) {
      await requireCallerTeamOwner(teamId);
      return aiGateway.setQuotas(teamId, input ?? {});
    },

    async listTeamActors(teamId, { kind = null, limit = 500 } = {}) {
      let query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("team_id", teamId)
        // Retired agents stay out of the listing; members pass on the null term.
        .or(LISTABLE_AGENT_STATUS_OR_FILTER);
      if (kind) query = query.eq("actor_type", kind);
      query = query.order("last_active_at", { ascending: false, nullsFirst: false })
                   .order("display_name", { ascending: true })
                   .limit(limit);
      const { data, error } = await query;
      if (error) throw error;
      // Typed explicitly: `data` is `any`, so an inline map left T to fall back
      // to enrichActorsWithOrgRoles' constraint and the result lost every actor
      // field but the few that constraint names.
      const actors: Array<ReturnType<typeof mapDirectoryActor>> = (data ?? []).map(mapDirectoryActor);
      const items = await enrichActorsWithOrgRoles(supabase, teamId, actors);
      return { items };
    },

    async listSessions({ limit = 50, cursor = null, teamId = null, ideaId = null, kind = "all" }: any = {}) {
      // p_team_id is what resolves the caller's actor as of 20260804020000,
      // since a user has one actor row per team. It is also load-bearing for
      // performance: only the team-scoped RPC can walk
      // `sessions_team_active_last_message_idx` and stop at `limit`. The
      // un-scoped `list_current_actor_sessions_all_teams` fallback that used to
      // serve callers without a teamId joined every participant row the caller
      // had, RLS-checked each one, then sorted — O(N), 4.5s at 6k sessions and a
      // statement_timeout 500 past ~13k. It is gone; the route rejects a missing
      // teamId with a 400 before reaching here.
      if (!teamId) {
        throw new ApiError(400, "validation_failed", "teamId is required");
      }
      const { data, error } = await supabase.rpc("list_current_actor_sessions", {
        p_limit: limit,
        p_before_last_message_at: cursor?.lastMessageAt ?? null,
        p_before_created_at: cursor?.createdAt ?? null,
        p_before_id: cursor?.id ?? null,
        // Narrowing happens inside the RPC (20260802000000). Doing it there
        // rather than post-filtering keeps the result correct under pagination
        // and is what lets this replace GET /v1/teams/:teamId/sessions.
        p_team_id: teamId,
        p_idea_id: ideaId ?? null,
        p_kind: kind,
      });
      if (error) throw error;
      return (data ?? []).map(mapSession);
    },

    // Desktop session-list v2. Independent RPC so /v1/sessions keeps
    // regular = non-cron. kind is required and partitioned:
    // regular | channel | app | cron (see 20261102000000).
    async listSessionsV2({ limit = 50, cursor = null, teamId = null, kind = null }: any = {}) {
      if (!teamId) {
        throw new ApiError(400, "validation_failed", "teamId is required");
      }
      if (!kind || !["regular", "channel", "app", "cron"].includes(kind)) {
        throw new ApiError(400, "validation_failed", "kind must be regular, channel, app, or cron");
      }
      const { data, error } = await supabase.rpc("list_current_actor_sessions_v2", {
        p_team_id: teamId,
        p_kind: kind,
        p_limit: limit,
        p_before_last_message_at: cursor?.lastMessageAt ?? null,
        p_before_created_at: cursor?.createdAt ?? null,
        p_before_id: cursor?.id ?? null,
        p_idea_id: null,
      });
      if (error) throw error;
      return (data ?? []).map(mapSession);
    },

    // Newest-first on the way out of Postgres so `limit` truncates the OLD end
    // of the history, then reversed so the page itself reads oldest-first — the
    // order every client already renders in. Fetching ascending and slicing
    // would keep the wrong end.
    async listMessages(sessionId, { limit = DEFAULT_MESSAGE_LIST_LIMIT, cursor = null }: any = {}) {
      let query = supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId);
      if (cursor?.createdAt) {
        // Keyset: strictly before (createdAt, id). PostgREST has no row-value
        // comparison, so express it as the equivalent OR — earlier timestamp, or
        // same timestamp with a smaller id.
        query = query.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
        );
      }
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(mapMessage).reverse();
    },

    async listSessionAttachments(sessionId, { limit = DEFAULT_LIST_LIMIT, cursor = null } = {}) {
      const scanRows = [];
      let messageCursor = null;
      for (;;) {
        let query = supabase
          .from("messages")
          .select(MESSAGE_ATTACHMENT_SCAN_COLUMNS)
          .eq("session_id", sessionId);
        if (messageCursor?.createdAt) {
          query = query.or(
            `created_at.lt.${messageCursor.createdAt},and(created_at.eq.${messageCursor.createdAt},id.lt.${messageCursor.id})`,
          );
        }
        const { data, error } = await query
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(MAX_MESSAGE_LIST_LIMIT);
        if (error) throw error;
        const batch = data ?? [];
        for (const row of batch) {
          scanRows.push({
            id: requiredString(row.id, "listSessionAttachments", "id"),
            kind: requiredString(row.kind, "listSessionAttachments", "kind"),
            metadata: row.metadata ?? null,
            senderActorId: row.sender_actor_id ?? null,
            createdAt: requiredString(row.created_at, "listSessionAttachments", "created_at"),
          });
        }
        if (batch.length < MAX_MESSAGE_LIST_LIMIT) break;
        const oldest = batch[batch.length - 1];
        messageCursor = { createdAt: oldest.created_at, id: oldest.id };
      }

      const sorted = aggregateSessionAttachmentsFromMessages(scanRows);
      const page = paginateSessionAttachments(sorted, cursor, limit);
      return {
        items: page.items,
        nextCursor: page.nextCursor
          ? encodeSessionAttachmentCursor(page.nextCursor)
          : null,
      };
    },

    async insertMessage(sessionId, input) {
      const { data, error } = await supabase
        .from("messages")
        .insert(outgoingMessageRow(sessionId, input))
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) throw error;

      if (fanoutMessage) {
        // The whole row, not a six-field digest: the agent inbox carries the
        // message itself (#1455 Phase 1), so `metadata` — which holds
        // `mention_actor_ids` and the attachment refs — has to travel with it.
        fanoutMessage(data).catch((err: unknown) => {
          console.error("[fanout] fanoutMessage failed (swallowed):", err);
        });
      }

      return mapMessage(data);
    },

    async patchMessage(messageId, patch) {
      const row: any = {};
      if (patch.content !== undefined) row.content = patch.content;
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
      const { data, error } = await supabase
        .from("messages")
        .update(row)
        .eq("id", messageId)
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapMessage(data);
    },

    async deleteMessage(messageId) {
      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("id", messageId);
      if (error) throw error;
    },

    // Turn execution traces (#1455 §7.2). amux.messages has no UPDATE policy, so
    // the pointer is written by SECURITY DEFINER functions that admit only the
    // agent that authored the reply and touch only `metadata.trace`, merged in
    // SQL (20260916120000_message_turn_trace.sql).
    async authorizeTurnTraceUpload({ teamId, sessionId, turnId, messageId }) {
      const { data, error } = await supabase.rpc("authorize_turn_trace_upload", {
        p_team_id: teamId,
        p_session_id: sessionId,
        p_turn_id: turnId,
        p_message_id: messageId,
      });
      if (error) throw turnTraceRpcError(error);
      return data && typeof data === "object" && !Array.isArray(data) ? data : null;
    },

    async recordTurnTrace({ teamId, sessionId, turnId, messageId }, trace) {
      const { data, error } = await supabase.rpc("record_turn_trace", {
        p_team_id: teamId,
        p_session_id: sessionId,
        p_turn_id: turnId,
        p_message_id: messageId,
        p_trace: trace,
      });
      if (error) throw turnTraceRpcError(error);
      return data;
    },

    async getTurnTrace({ teamId, sessionId, turnId }) {
      // Only agent rows carry a turn_id, and a turn has one cloud reply per
      // session, so this reads a row or two off messages_turn_id_idx. RLS limits
      // it to session participants.
      const { data, error } = await supabase
        .from("messages")
        .select("trace:metadata->trace")
        .eq("team_id", teamId)
        .eq("session_id", sessionId)
        .eq("turn_id", turnId)
        .limit(10);
      if (error) throw error;
      return (data ?? []).map((row: any) => row.trace).find((trace) => trace) ?? null;
    },

    async listWorkspaces({ teamId, limit = 50, cursor = null, agentId = null }: any = {}) {
      let query = supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (agentId) {
        query = query.eq("agent_id", agentId);
      }
      if (cursor?.updatedAt) {
        query = applyWorkspaceKeysetCursor(query, cursor);
      }
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapWorkspace) };
    },

    async upsertWorkspace(input) {
      // AUTHZ: created_by / agent_id are ALWAYS resolved server-side from the
      // authenticated caller scoped to the target team. Any client-supplied
      // `input.createdByMemberId` is ignored — a multi-team user's client can
      // send the wrong team's member actor id (stale current-team value), which
      // the workspaces INSERT RLS WITH CHECK then rejects. Deriving it here
      // guarantees the row satisfies the team-scoped policy regardless of what
      // the client sends (mirrors createSession / createApp).
      //
      // Headless daemons authenticate as an agent actor. RLS allows INSERT via
      // `workspaces_agent_write` when `agent_id = current agent`; member-only
      // resolution used to reject every daemon `POST /v1/workspaces`.
      const { createdByMemberId, agentId } = await this.resolveWorkspaceUpsertAuth(input);

      // Dedup key: explicit `id` always wins. Otherwise reuse by (team, path)
      // or by (team, agent, name) — the table's unique constraint is
      // (team_id, agent_id, name), and onConflict:"id" alone mints a fresh
      // UUID that collides with that constraint when re-adding an existing /
      // archived workspace.
      let targetId = input.id ?? null;
      const normalizedPath = normalizeWorkspacePath(input.path ?? input.slug ?? null);
      let resolvedName = input.name;

      if (!targetId && normalizedPath) {
        const { data: byKey, error: keyErr } = await supabase
          .from("workspaces")
          .select("id")
          .eq("team_id", input.teamId)
          .eq("path_key", normalizedPath)
          .limit(1);
        if (keyErr) throw keyErr;
        if (byKey?.[0]?.id) targetId = byKey[0].id;
      }

      if (!targetId && normalizedPath) {
        const { data: byPath, error: pathErr } = await supabase
          .from("workspaces")
          .select("id")
          .eq("team_id", input.teamId)
          .in("path", [normalizedPath, `${normalizedPath}/`])
          .limit(1);
        if (pathErr) throw pathErr;
        if (byPath?.[0]?.id) targetId = byPath[0].id;
      }

      if (!targetId) {
        let byNameQuery = supabase
          .from("workspaces")
          .select("id, path, archived")
          .eq("team_id", input.teamId)
          .eq("name", resolvedName);
        byNameQuery = agentId
          ? byNameQuery.eq("agent_id", agentId)
          : byNameQuery.is("agent_id", null);
        const { data: byNameRows, error: nameErr } = await byNameQuery.limit(1);
        if (nameErr) throw nameErr;
        const existingByName = byNameRows?.[0];
        if (existingByName) {
          const existingPath = normalizeWorkspacePath(existingByName.path);
          if (normalizedPath && existingPath === normalizedPath) {
            targetId = existingByName.id;
          } else if (existingByName.archived) {
            targetId = existingByName.id;
          } else {
            resolvedName = await findUniqueWorkspaceName(
              supabase,
              input.teamId,
              agentId,
              resolvedName,
            );
          }
        }
      }

      let createdByMemberIdForRow = createdByMemberId;
      let agentIdForRow = agentId;
      let archivedAtBeforeRevive: string | null = null;
      if (targetId) {
        const { data: existing, error: existingErr } = await supabase
          .from("workspaces")
          .select("agent_id, created_by_member_id, archived, updated_at")
          .eq("id", targetId)
          .maybeSingle();
        if (existingErr) throw existingErr;
        if (existing?.agent_id) agentIdForRow = existing.agent_id;
        if (createdByMemberId === null && existing?.created_by_member_id) {
          createdByMemberIdForRow = existing.created_by_member_id;
        }
        if (existing?.archived === true && typeof existing.updated_at === "string") {
          archivedAtBeforeRevive = existing.updated_at;
        }
      }

      const row: Record<string, unknown> = {
        team_id: input.teamId,
        name: resolvedName,
        path: normalizedPath,
        path_key: normalizedPath,
        agent_id: agentIdForRow,
        created_by_member_id: createdByMemberIdForRow,
        archived: input.archived ?? false,
      };
      if (targetId) row.id = targetId;

      const { data, error } = await supabase
        .from("workspaces")
        .upsert(row, { onConflict: "id" })
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) throw error;
      // Re-adding a folder (by hand, or a daemon registering its default)
      // revives the archived row for it. That is a restore too: bring back the
      // sessions the archive took, as patchWorkspace does.
      if (archivedAtBeforeRevive && row.archived === false && targetId) {
        await restoreSessionsForWorkspace(supabase, targetId, archivedAtBeforeRevive);
      }
      return mapWorkspace(data);
    },

    async getWorkspace(workspaceId) {
      const { data, error } = await supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("id", workspaceId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapWorkspace(data);
    },

    async patchWorkspace(workspaceId, patch) {
      const row: any = {};
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.archived !== undefined) row.archived = patch.archived;
      // `path_key` is the workspace's identity: the partial unique index on
      // (team_id, path_key) is what keeps two live rows off one folder. A PATCH
      // that moved `path` alone left `path_key` behind, so a row could be
      // repointed at a folder another live row already held and the index
      // never saw it — the daemon then refused every session there as
      // "ambiguous or invalid workspace". Normalize the same way the upsert
      // does and move both; a collision now fails as 409 duplicate_key.
      const rawPath = patch.path !== undefined ? patch.path : patch.slug;
      if (rawPath !== undefined) {
        const normalizedPath = normalizeWorkspacePath(rawPath);
        row.path = normalizedPath;
        row.path_key = normalizedPath;
      }
      if (patch.agentId !== undefined) row.agent_id = patch.agentId;
      // Restoring needs the instant the workspace was archived, which is the
      // row's updated_at as it stands now (the archive stamped its sessions
      // with it). Read it before the UPDATE moves it.
      let archivedAtBeforeRestore: string | null = null;
      if (patch.archived === false) {
        const { data: before, error: beforeErr } = await supabase
          .from("workspaces")
          .select("archived, updated_at")
          .eq("id", workspaceId)
          .maybeSingle();
        if (beforeErr) throw beforeErr;
        if (before?.archived === true && typeof before.updated_at === "string") {
          archivedAtBeforeRestore = before.updated_at;
        }
      }
      const { data, error } = await supabase
        .from("workspaces")
        .update(row)
        .eq("id", workspaceId)
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      if (patch.archived === true) {
        await archiveSessionsForWorkspace(supabase, workspaceId, data?.updated_at ?? undefined);
      } else if (archivedAtBeforeRestore) {
        await restoreSessionsForWorkspace(supabase, workspaceId, archivedAtBeforeRestore);
      }
      return mapWorkspace(data);
    },

    async writeForegroundPresence({ deviceId, foregroundUntil }) {
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) {
        throw new ApiError(401, "unauthorized", "no authenticated user");
      }
      const { error } = await supabase
        .from("client_presence")
        .upsert(
          { user_id: userId, device_id: deviceId, foreground_until: foregroundUntil },
          { onConflict: "user_id,device_id" }
        );
      if (error) throw error;
    },

    async listShortcutsByScope({ scope, teamId, parentId }: any = {}) {
      let query = supabase.from("shortcuts").select("*").eq("scope", scope);
      if (scope === "team" && teamId) query = query.eq("team_id", teamId);
      // Personal scope is gated by RLS on owner_member_id; no extra filter here.
      if (parentId !== undefined) {
        if (parentId === null) query = query.is("parent_id", null);
        else query = query.eq("parent_id", parentId);
      }
      const { data, error } = await query.order("order", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapShortcut);
    },

    async getNotificationPrefs() {
      const { data, error } = await supabase
        .from("notification_prefs")
        .select("user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at")
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      // Frontend expects snake_case raw row shape; returns null when caller
      // has no prefs row yet so it can fall back to DEFAULT_PREFS.
      return row ?? null;
    },

    async registerDevicePushToken(input) {
      // Identity comes from the bearer token, not the client, mirroring
      // writeForegroundPresence. Clients send device/platform/provider/token.
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const row = {
        user_id: userId,
        device_id: input.deviceId,
        platform: input.platform ?? "ios",
        provider: input.provider ?? "apns",
        token: input.token,
        app_version: input.appVersion ?? null,
        last_seen_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("device_push_tokens")
        .upsert(row, { onConflict: "user_id,device_id,provider" });
      if (error) throw error;
    },

    async putNotificationPrefs(input) {
      // Identity comes from the bearer token (auth.getUser), not the body —
      // CloudAPI clients no longer hold a Supabase user id.
      const { data: prefUser, error: prefUserErr } = await getCurrentUser();
      if (prefUserErr) throw prefUserErr;
      const prefUserId = input.user_id ?? prefUser?.user?.id;
      if (!prefUserId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Accept snake_case from the frontend (matches the on-disk row shape).
      const row = {
        user_id: prefUserId,
        enabled: input.enabled ?? true,
        dnd_start_min: input.dnd_start_min ?? null,
        dnd_end_min: input.dnd_end_min ?? null,
        dnd_tz: input.dnd_tz ?? "Asia/Shanghai",
      };
      const { data, error } = await supabase
        .from("notification_prefs")
        .upsert(row, { onConflict: "user_id" })
        .select("user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at")
        .single();
      if (error) throw error;
      return data;
    },

    async muteSession(sessionId, input) {
      const row = {
        session_id: sessionId,
        until: input.until ?? null,
      };
      const { error } = await supabase
        .from("session_mutes")
        .upsert(row, { onConflict: "user_id,session_id" });
      if (error) throw error;
    },

    async unmuteSession(sessionId) {
      const { error } = await supabase
        .from("session_mutes")
        .delete()
        .eq("session_id", sessionId);
      if (error) throw error;
    },

    async listMutedSessions() {
      const { data, error } = await supabase
        .from("session_mutes")
        .select("session_id");
      if (error) throw error;
      return { items: (data ?? []).map((r) => r.session_id) };
    },

    async listIdeas({ teamId, archived = false, limit = 50, cursor = null }: any = {}) {
      // `amux.idea_feed` rather than a select on ideas: the feed card shows a
      // comment count, a like count and whether the viewer has liked it, and
      // a plain select would mean N more round trips per page.
      //
      // It also fixes the keyset, which the select got wrong: `lt(updated_at)`
      // alone drops every row sharing the page boundary's timestamp. The
      // function compares the (updated_at, id) pair the cursor already
      // carried.
      const { data, error } = await supabase.rpc("idea_feed", {
        p_team_id: teamId,
        p_archived: archived,
        // One past the page, so the route can tell whether to emit a cursor.
        p_limit: limit + 1,
        p_before_updated_at: cursor?.updatedAt ?? null,
        p_before_id: cursor?.id ?? null,
      });
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapIdeaFeedRow) };
    },

    async getIdea(ideaId) {
      const { data, error } = await supabase
        .from("ideas")
        .select("*")
        .eq("id", ideaId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapIdeaRow(data);
    },

    async createIdea(body) {
      const args: any = {
        p_team_id: body.teamId,
        p_title: body.title,
        p_description: body.description ?? body.body ?? "",
      };
      if (body.workspaceId != null) args.p_workspace_id = body.workspaceId;
      const { data, error } = await supabase.rpc("create_idea", args);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const id = requiredString(row?.id, "ideas.createIdea", "id");
      // Pictures are a second call rather than a fifth argument to
      // create_idea — see the migration for why that function is left alone.
      // Not one transaction: a failure here leaves the post without its
      // images, which is visible and fixable.
      const attachmentUrls = body.attachmentUrls ?? body.attachment_urls;
      if (Array.isArray(attachmentUrls) && attachmentUrls.length > 0) {
        const { error: attachError } = await supabase.rpc("set_idea_attachments", {
          p_idea_id: id,
          p_attachment_urls: attachmentUrls,
        });
        if (attachError) throw attachError;
      }
      return this.getIdea(id);
    },

    async setIdeaLike(ideaId, liked) {
      const { data, error } = await supabase.rpc("set_idea_like", {
        p_idea_id: ideaId,
        p_liked: liked === true,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        likeCount: Number(row?.like_count ?? 0),
        likedByMe: row?.liked_by_me === true,
      };
    },

    async updateIdea(ideaId, body) {
      const { error } = await supabase.rpc("update_idea", {
        p_idea_id: ideaId,
        p_title: body.title ?? null,
        p_workspace_id: body.workspaceId ?? null,
        p_description: body.description ?? body.body ?? null,
        p_status: body.status ?? null,
      });
      if (error) throw error;
      return this.getIdea(ideaId);
    },

    async archiveIdea(ideaId, { archived = true } = {}) {
      const { error } = await supabase.rpc("archive_idea", { p_idea_id: ideaId, p_archived: archived });
      if (error) throw error;
    },

    async listShortcuts(teamId, { parentId }: any = {}) {
      let query = supabase
        .from("shortcuts")
        .select("*")
        .eq("team_id", teamId)
        .order("order", { ascending: true });
      if (parentId !== undefined) {
        if (parentId === null) {
          query = query.is("parent_id", null);
        } else {
          query = query.eq("parent_id", parentId);
        }
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map(mapShortcutRow);
    },

    async getShortcut(shortcutId) {
      const { data, error } = await supabase
        .from("shortcuts")
        .select("*")
        .eq("id", shortcutId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapShortcutRow(data);
    },

    async createShortcut(body) {
      const args = {
        p_scope: body.scope,
        p_label: body.label,
        p_node_type: body.nodeType ?? body.kind,
        p_team_id: body.teamId ?? null,
        p_parent_id: body.parentId ?? null,
        p_icon: body.icon ?? null,
        p_order: body.order ?? body.position ?? 0,
        p_target: body.target ?? "",
      };
      const { data, error } = await supabase.rpc("shortcut_create", args);
      if (error) throw error;
      const id = requiredString(data, "shortcuts.createShortcut", "id");
      return this.getShortcut(id);
    },

    async updateShortcut(shortcutId, patch) {
      const body: any = {};
      if (patch.label !== undefined) body.label = patch.label;
      if (patch.payload !== undefined) body.payload = patch.payload;
      if (patch.parentId !== undefined) body.parent_id = patch.parentId;
      if (patch.position !== undefined) body.position = patch.position;
      const { data, error } = await supabase
        .from("shortcuts")
        .update(body)
        .eq("id", shortcutId)
        .select("*")
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapShortcutRow(data);
    },

    async deleteShortcut(shortcutId) {
      const { error } = await supabase
        .from("shortcuts")
        .delete()
        .eq("id", shortcutId);
      if (error) throw error;
    },

    async batchMoveShortcuts({ moves }) {
      const { error } = await supabase.rpc("shortcut_batch_move", {
        p_moves: moves.map((m) => ({ shortcut_id: m.shortcutId, parent_id: m.parentId, position: m.position })),
      });
      if (error) throw error;
    },

    async createIdeaActivity(ideaId, body) {
      const { data, error } = await supabase.rpc("create_idea_activity", {
        p_idea_id: ideaId,
        p_activity_type: body.activityType ?? body.kind,
        p_content: body.content ?? null,
        p_metadata: body.metadata ?? null,
        p_attachment_urls: body.attachmentUrls ?? [],
      });
      if (error) throw error;
      return mapIdeaActivityRow(requiredRow(data, "ideas.createIdeaActivity"));
    },

    async listIdeaActivities(ideaId) {
      const { data, error } = await supabase
        .from("idea_activities")
        .select("id, team_id, idea_id, actor_id, activity_type, content, metadata, attachment_urls, created_at, updated_at")
        .eq("idea_id", ideaId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return { items: (data ?? []).map(mapIdeaActivityRow) };
    },

    async reorderIdeas({ teamId, ideaIds }) {
      const { error } = await supabase.rpc("reorder_ideas", {
        p_team_id: teamId,
        p_idea_ids: ideaIds,
      });
      if (error) throw error;
    },





    async ensureAgentTypes({ supportedTypes, defaultAgentType }) {
      // Keep the default a member of the supported set (see normalizeAgentTypes).
      const norm = normalizeAgentTypes(supportedTypes, defaultAgentType);
      const { data: authData, error: authErr } = await getCurrentUser();
      if (authErr || !authData?.user?.id) {
        throw new Error("ensureAgentTypes: authenticated user required");
      }
      // Resolve the caller's own agent actor — NOT `.limit(1)` on all team
      // agents (that picks the wrong row when multiple agents exist). Daemon
      // JWTs may have empty app_metadata; actors.user_id = auth.uid() is the
      // stable routing identity (see app.is_current_agent).
      const { data: actorRow, error: actorErr } = await supabase
        .from("actors")
        .select("id")
        .eq("user_id", authData.user.id)
        .eq("actor_type", "agent")
        .maybeSingle();
      if (actorErr) throw actorErr;
      if (!actorRow?.id) {
        throw new Error("ensureAgentTypes: no agent actor visible to caller");
      }
      const { data: updated, error } = await supabase
        .from("agents")
        .update({
          agent_types: norm.supportedTypes,
          default_agent_type: norm.defaultAgentType,
        })
        .eq("id", actorRow.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!updated?.id) {
        throw new Error(
          "ensureAgentTypes: update did not apply (agent row missing or RLS denied)",
        );
      }
    },

    async uploadAttachment({ path, mime, bytes, bucket }) {
      const targetBucket = bucket || DEFAULT_ATTACHMENT_BUCKET;
      const { error } = await supabase.storage
        .from(targetBucket)
        .upload(path, bytes, { contentType: mime, upsert: true });
      if (error) throw error;
      const encodedPath = encodeStorageObjectKeyForUrl(path);
      return {
        path,
        url: `${supabasePublicUrl}/storage/v1/object/public/${targetBucket}/${encodedPath}`,
      };
    },

    async downloadAttachment(path, { bucket }: any = {}) {
      const targetBucket = bucket || DEFAULT_ATTACHMENT_BUCKET;
      const { data, error } = await supabase.storage
        .from(targetBucket)
        .download(path);
      if (error) {
        const status = Number(error?.status || error?.statusCode || 0);
        if (status === 404 || error?.message?.includes("not found") || error?.error === "not_found") return null;
        throw error;
      }
      if (!data) return null;
      const arrayBuffer = await data.arrayBuffer();
      const mime = data.type || "application/octet-stream";
      return { mime, bytes: Buffer.from(arrayBuffer) };
    },

    /// Same object, resized by the storage service on its way out.
    async downloadAttachmentThumbnail(path, { bucket, width, quality }: any = {}) {
      const targetBucket = bucket || DEFAULT_ATTACHMENT_BUCKET;
      // `transform` sends this through `/render/image/...`, which imgproxy
      // serves. That path wants credentials where `/object/public/...` does
      // not, which is the whole reason this goes through FC: the clients
      // deliberately hold no Supabase key.
      const { data, error } = await supabase.storage
        .from(targetBucket)
        .download(path, { transform: { width, resize: "contain", quality } });
      if (error) {
        const status = Number(error?.status || error?.statusCode || 0);
        if (status === 404 || error?.message?.includes("not found") || error?.error === "not_found") return null;
        throw error;
      }
      if (!data) return null;
      const arrayBuffer = await data.arrayBuffer();
      const mime = data.type || "image/jpeg";
      return { mime, bytes: Buffer.from(arrayBuffer) };
    },

    async submitFeedback(body) {
      const row = {
        message_id: body.messageId,
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        kind: body.kind,
        star_rating: body.starRating ?? null,
        skill: body.skill ?? null,
      };
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .upsert(row, { onConflict: "actor_id,message_id" })
        .select("*")
        .single();
      if (error) throw error;
      return mapFeedbackRow(data);
    },

    async listFeedback({ sessionId }) {
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .select("*")
        .eq("session_id", sessionId);
      if (error) throw error;
      return { items: (data ?? []).map(mapFeedbackRow) };
    },

    async deleteFeedback(messageId, actorId) {
      const query = supabase
        .from("actor_message_feedback")
        .delete()
        .eq("message_id", messageId);
      if (actorId) query.eq("actor_id", actorId);
      const { error } = await query;
      if (error) throw error;
    },

    async getTeamLeaderboard(teamId, { period = "week" } = {}) {
      const [board, contributions] = await Promise.all([
        supabase.rpc("team_leaderboard", { p_team_id: teamId, p_period: period }),
        // Published skills + created apps. A separate SECURITY DEFINER function
        // (see migration 20260916190000) so personal apps count for every viewer.
        supabase.rpc("team_leaderboard_contributions", { p_team_id: teamId }),
      ]);
      if (board.error) throw board.error;
      const contributionsByActor = new Map();
      if (contributions.error) {
        // A database that has not run the migration yet: show zero
        // contributions rather than failing the whole leaderboard.
        const code = contributions.error?.code;
        if (code !== "PGRST202" && code !== "42883") throw contributions.error;
        console.warn("[leaderboard] team_leaderboard_contributions missing; counting 0", { code });
      } else {
        for (const row of contributions.data ?? []) contributionsByActor.set(row.actor_id, row);
      }
      const rows = (board.data ?? []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return { items: rows.map((row) => mapLeaderboardRow(row, contributionsByActor.get(row.actor_id))) };
    },

    async submitSessionReport(body) {
      // Not transactional: the report row may be written even if the
      // subsequent skill-usage insert fails. Acceptable for best-effort
      // telemetry — a throw here means the caller sees failure, but the
      // report row can still exist. supabase-js has no multi-table txn.
      const reportRow = {
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        tokens_used: body.tokensUsed ?? 0,
        cost_usd: body.costUsd ?? 0,
        model: body.model ?? null,
        agent_kind: body.agentKind ?? null,
        ended_at: body.endedAt ?? null,
      };
      const { error: reportErr } = await supabase
        .from("actor_session_report")
        .insert(reportRow);
      if (reportErr) throw reportErr;

      const skillRows = Object.entries(body.skillUsage ?? {})
        .filter(([, count]) => Number(count) > 0)
        .map(([skill, count]) => ({
          actor_id: body.actorId,
          team_id: body.teamId,
          session_id: body.sessionId ?? null,
          skill,
          count: Number(count),
        }));
      if (skillRows.length > 0) {
        const { error: skillErr } = await supabase
          .from("actor_skill_usage")
          .insert(skillRows);
        if (skillErr) throw skillErr;
      }
    },

    async submitSkillUsage(body) {
      const row = {
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        skill: body.skill,
        count: Number(body.count ?? 1),
      };
      const { error } = await supabase.from("actor_skill_usage").insert(row);
      if (error) throw error;
    },

    async listFeedbackSummary(teamId) {
      // TODO: replace with a DB-side GROUP BY aggregate (or a view/rpc) when
      // per-team feedback row counts grow — this fetches all rows and reduces
      // in JS. displayName is left null here; callers resolve it separately
      // (the leaderboard rpc already returns display_name).
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .select("actor_id, kind")
        .eq("team_id", teamId);
      if (error) throw error;
      const byActor = new Map();
      for (const r of data ?? []) {
        const e = byActor.get(r.actor_id) ?? { actorId: r.actor_id, displayName: null, positive: 0, negative: 0, total: 0 };
        if (r.kind === "positive") e.positive += 1;
        if (r.kind === "negative") e.negative += 1;
        e.total += 1;
        byActor.set(r.actor_id, e);
      }
      return { items: [...byActor.values()] };
    },

    // --- Directory resolution (frontend supabase delegate parity) ---

    async resolveCallerActorForTeam(teamId) {
      // Resolve the bearer caller's actor in this team, member OR agent. The
      // daemon authenticates as an "agent" actor (its machine-bound identity),
      // and team MCP / team skills / team env must resolve that actor so the
      // daemon can install/read them — `resolveCurrentMemberActor` below is
      // member-only and is reserved for the human member directory.
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) return null;
      return this.resolveCurrentActor(teamId, userId);
    },

    // The caller's single actor in this team regardless of `actor_type`.
    // `actors_team_user_idx` guarantees at most one actor per (team, user), so
    // this is unambiguous: a human resolves to their member actor, a daemon
    // resolves to its agent actor.
    async resolveCurrentActor(teamId, userId): Promise<{ id: string; actorType: string | null } | null> {
      const { data, error } = await supabase
        .from("actors")
        .select("id, actor_type")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, actorType: data.actor_type ?? null } : null;
    },

    async resolveCurrentMemberActor(teamId, userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id } : null;
    },

    async resolveWorkspaceUpsertAuth(input) {
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");

      const member = await this.resolveCurrentMemberActor(input.teamId, userId);
      if (member?.id) {
        return {
          createdByMemberId: member.id,
          agentId: input.agentId ?? null,
        };
      }

      const caller = await this.resolveCurrentActor(input.teamId, userId);
      if (!caller?.id) {
        throw new ApiError(403, "forbidden", "not a member of this team");
      }
      const requestedAgentId = input.agentId ?? null;
      if (!requestedAgentId || requestedAgentId !== caller.id) {
        throw new ApiError(
          403,
          "forbidden",
          "agent callers may only register workspaces for their own agent id",
        );
      }
      return { createdByMemberId: null, agentId: caller.id };
    },

    async resolveFirstMemberActorForUser(userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id, team_id")
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, team_id: data.team_id ?? null } : null;
    },

    async getCurrentTeamMember(teamId, userId) {
      const { data: actorRows, error: actorError } = await supabase
        .from("actor_directory")
        .select("id, display_name, user_id, actor_type")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1);
      if (actorError) throw actorError;
      const actor = actorRows?.[0];
      if (!actor) return null;
      const { data: memberRows, error: memberError } = await supabase
        .from("team_members")
        .select("joined_at")
        .eq("team_id", teamId)
        .eq("member_id", actor.id)
        .limit(1);
      const [enriched] = await enrichActorsWithOrgRoles(supabase, teamId, [
        {
          id: actor.id,
          userId: actor.user_id ?? userId,
          kind: actor.actor_type ?? "member",
        },
      ]);
      return {
        id: actor.id,
        displayName: actor.display_name || "",
        roles: enriched?.roles ?? [],
        role: enriched?.teamRole ?? null,
        joinedAt: memberError ? null : memberRows?.[0]?.joined_at ?? null,
      };
    },

    // --- Sync (incremental) ---

    // Every *ForSync reader below walks FORWARD through (updated_at, id) — the
    // sync contract is "everything changed since X", and updated_at is the only
    // column that moves monotonically as rows are touched. They were unbounded:
    // a first-time sync of a large team returned every row in one response
    // (10k actors measured 3.1MB / 4.4s). `limit`/`cursor` are optional on the
    // wire; a caller that ignores nextCursor now gets a truncated first page
    // rather than a response that grows without limit, so clients MUST page to
    // exhaustion — see applySyncKeyset for the shared shape.
    async listActorDirectoryForSync(teamId, updatedAfter, { limit = DEFAULT_LIST_LIMIT, cursor = null }: any = {}) {
      let q = supabase
        .from("actor_directory")
        .select(
          "id, team_id, actor_type, display_name, avatar_url, member_status, agent_status, last_active_at, created_at, updated_at",
        )
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await applySyncKeyset(q, cursor, limit);
      if (error) throw error;
      return data ?? [];
    },

    async listIdeasForSync(teamId, updatedAfter, { limit = DEFAULT_LIST_LIMIT, cursor = null }: any = {}) {
      let q = supabase
        .from("ideas")
        .select(
          "id, team_id, workspace_id, parent_idea_id, title, description, status, created_by_actor_id, archived, sort_order, created_at, updated_at",
        )
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await applySyncKeyset(q, cursor, limit);
      if (error) throw error;
      return data ?? [];
    },

    async listSessionParticipantsForSync(sessionId, updatedAfter, { limit = DEFAULT_LIST_LIMIT, cursor = null }: any = {}) {
      let q = supabase
        .from("session_participants")
        .select("id, session_id, actor_id, joined_at, created_at, updated_at")
        .eq("session_id", sessionId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await applySyncKeyset(q, cursor, limit);
      if (error) throw error;
      return data ?? [];
    },

    // --- Actor directory by ids + remove agent access ---

    async listActorDirectoryByIds(actorIds, teamId) {
      if (!Array.isArray(actorIds) || actorIds.length === 0) return [];
      const rows = await chunkedIn(actorIds, async (chunk) => {
        let q = supabase
          .from("actor_directory")
          .select(ACTOR_DIRECTORY_COLUMNS)
          .in("id", chunk);
        if (teamId) q = q.eq("team_id", teamId);
        const { data, error } = await q;
        if (error) throw error;
        return data ?? [];
      });
      // Roles live in roles_users, not in actor_directory, and without teamId the
      // ids can span teams (and so orgs): enrich each team's rows on its own.
      const actors = rows.map(mapDirectoryActor);
      const enrichedById = new Map();
      for (const tid of new Set(actors.map((a) => a.teamId).filter(Boolean))) {
        const group = actors.filter((a) => a.teamId === tid);
        for (const a of await enrichActorsWithOrgRoles(supabase, tid, group)) {
          enrichedById.set(a.id, a);
        }
      }
      return actors.map((a) => enrichedById.get(a.id) ?? a);
    },

    async removeAgentAccessById(accessId) {
      const { error } = await supabase
        .from("agent_member_access")
        .delete()
        .eq("id", accessId);
      if (error) throw error;
    },

    // --- Team workspace git config (separate column set from
    // existing default/pinned workspace config) ---


    async listSessionsForTeamSince(teamId, updatedAfter, { limit = DEFAULT_LIST_LIMIT, cursor = null }: any = {}) {
      const SESSION_SYNC_COLUMNS =
        "id, team_id, title, mode, primary_agent_id, idea_id, summary, last_message_preview, last_message_at, created_by_actor_id, source, cron_job_id, created_at, updated_at";
      let q = supabase
        .from("sessions")
        .select(SESSION_SYNC_COLUMNS)
        .eq("team_id", teamId)
        .is("parent_session_id", null);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await applySyncKeyset(q, cursor, limit);
      if (error) throw error;
      return data ?? [];
    },

    async listMessagesForSessionSince(sessionId, updatedAfter, { limit = DEFAULT_LIST_LIMIT, cursor = null }: any = {}) {
      const MESSAGE_SYNC_COLUMNS =
        "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";
      let q = supabase
        .from("messages")
        .select(MESSAGE_SYNC_COLUMNS)
        .eq("session_id", sessionId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await applySyncKeyset(q, cursor, limit);
      if (error) throw error;
      return data ?? [];
    },

    async listSessionDisplayRows(teamId, sessionIds) {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
      return chunkedIn(sessionIds, async (chunk) => {
        const { data, error } = await supabase
          .from("sessions")
          .select("id, title")
          .eq("team_id", teamId)
          .in("id", chunk);
        if (error) throw error;
        return data ?? [];
      });
    },

    async createThread(parentSessionId, { rootMessageId }) {
      if (!rootMessageId?.trim()) {
        throw new ApiError(400, "validation_failed", "rootMessageId is required");
      }

      const { data: parent, error: parentErr } = await supabase
        .from("sessions")
        .select("id, team_id, title, mode, idea_id, primary_agent_id, parent_session_id")
        .eq("id", parentSessionId)
        .maybeSingle();
      if (parentErr) throw parentErr;
      if (!parent) throw new ApiError(404, "not_found", "parent session not found");
      if (parent.parent_session_id) {
        throw new ApiError(400, "validation_failed", "cannot open a thread on a thread session");
      }

      const callerActorId = (await this.resolveCallerActorForTeam(parent.team_id))?.id ?? null;
      if (!callerActorId) {
        throw new ApiError(401, "missing_identity", "authentication required");
      }

      const { data: callerSeat, error: seatErr } = await supabase
        .from("session_participants")
        .select("actor_id")
        .eq("session_id", parentSessionId)
        .eq("actor_id", callerActorId)
        .maybeSingle();
      if (seatErr) throw seatErr;
      if (!callerSeat) {
        throw new ApiError(403, "forbidden", "not a participant in the parent session");
      }

      const { data: existing, error: existingErr } = await supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("thread_root_message_id", rootMessageId)
        .maybeSingle();
      if (existingErr) throw existingErr;
      if (existing) {
        if (existing.parent_session_id !== parentSessionId) {
          throw new ApiError(
            400,
            "validation_failed",
            "rootMessageId is already bound to a different parent session",
          );
        }
        const { data: threadSeat, error: threadSeatErr } = await supabase
          .from("session_participants")
          .select("actor_id")
          .eq("session_id", existing.id)
          .eq("actor_id", callerActorId)
          .maybeSingle();
        if (threadSeatErr) throw threadSeatErr;
        if (!threadSeat) {
          throw new ApiError(403, "forbidden", "not a participant in the thread session");
        }
        const { items } = await this.listSessionParticipants(existing.id);
        return { ...mapSessionFull(existing), participants: items };
      }

      const { data: rootMsg, error: rootErr } = await supabase
        .from("messages")
        .select("id, session_id, kind, content")
        .eq("id", rootMessageId)
        .eq("session_id", parentSessionId)
        .maybeSingle();
      if (rootErr) throw rootErr;
      if (!rootMsg) {
        throw new ApiError(404, "not_found", "root message not found in parent session");
      }
      if (rootMsg.kind !== "agent_reply") {
        throw new ApiError(
          400,
          "validation_failed",
          "rootMessageId must reference an agent_reply message",
        );
      }

      const preview = String(rootMsg.content ?? "").trim().slice(0, 80);
      const threadTitle = preview
        ? `${parent.title} · ${preview}${preview.length >= 80 ? "…" : ""}`
        : `${parent.title} · 话题`;

      const childId = randomUUID();
      const { data: child, error: insertErr } = await supabase
        .from("sessions")
        .insert({
          id: childId,
          team_id: parent.team_id,
          title: threadTitle,
          mode: parent.mode ?? "collab",
          idea_id: parent.idea_id ?? null,
          primary_agent_id: parent.primary_agent_id ?? null,
          created_by_actor_id: callerActorId,
          source: "thread",
          parent_session_id: parentSessionId,
          thread_root_message_id: rootMessageId,
        })
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (insertErr) throw insertErr;

      const { data: parentSeats, error: parentSeatsErr } = await supabase
        .from("session_participants")
        .select("actor_id")
        .eq("session_id", parentSessionId);
      if (parentSeatsErr) throw parentSeatsErr;

      const participantIds = Array.from(
        new Set(
          (parentSeats ?? [])
            .map((row) => row.actor_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      );
      if (participantIds.length > 0) {
        const rows = participantIds.map((actorId) => ({
          session_id: childId,
          actor_id: actorId,
        }));
        const { error: partErr } = await supabase
          .from("session_participants")
          // `ignoreDuplicates`: without it this is ON CONFLICT DO UPDATE, and
          // the table has no UPDATE policy - a seat that already exists (the
          // creator's, for one) would fail the whole call on RLS.
          .upsert(rows, { onConflict: "session_id,actor_id", ignoreDuplicates: true });
        if (partErr) throw partErr;
      }

      const { items } = await this.listSessionParticipants(childId);
      return { ...mapSessionFull(child), participants: items };
    },

    async listThreadSummaries(parentSessionId) {
      const { data: parent, error: parentErr } = await supabase
        .from("sessions")
        .select("id, team_id")
        .eq("id", parentSessionId)
        .maybeSingle();
      if (parentErr) throw parentErr;
      if (!parent) throw new ApiError(404, "not_found", "parent session not found");

      const callerActorId = (await this.resolveCallerActorForTeam(parent.team_id))?.id ?? null;
      if (!callerActorId) {
        throw new ApiError(401, "missing_identity", "authentication required");
      }

      const { data: callerSeat, error: seatErr } = await supabase
        .from("session_participants")
        .select("actor_id")
        .eq("session_id", parentSessionId)
        .eq("actor_id", callerActorId)
        .maybeSingle();
      if (seatErr) throw seatErr;
      if (!callerSeat) {
        throw new ApiError(403, "forbidden", "not a participant in the parent session");
      }

      const { data: threads, error: threadsErr } = await supabase
        .from("sessions")
        .select("id, thread_root_message_id, last_message_at")
        .eq("parent_session_id", parentSessionId);
      if (threadsErr) throw threadsErr;
      if (!threads?.length) return [];

      const threadIds = threads.map((row) => row.id).filter(Boolean);
      const participantCounts = new Map<string, number>();
      const messageCounts = new Map<string, number>();

      if (threadIds.length > 0) {
        const { data: partRows, error: partErr } = await supabase
          .from("session_participants")
          .select("session_id")
          .in("session_id", threadIds);
        if (partErr) throw partErr;
        for (const row of partRows ?? []) {
          if (!row.session_id) continue;
          participantCounts.set(
            row.session_id,
            (participantCounts.get(row.session_id) ?? 0) + 1,
          );
        }

        const { data: msgRows, error: msgErr } = await supabase
          .from("messages")
          .select("session_id")
          .in("session_id", threadIds);
        if (msgErr) throw msgErr;
        for (const row of msgRows ?? []) {
          if (!row.session_id) continue;
          messageCounts.set(row.session_id, (messageCounts.get(row.session_id) ?? 0) + 1);
        }
      }

      return threads.map((row) => ({
        threadSessionId: row.id,
        rootMessageId: row.thread_root_message_id,
        messageCount: messageCounts.get(row.id) ?? 0,
        lastMessageAt: row.last_message_at ?? null,
        participantCount: participantCounts.get(row.id) ?? 0,
      }));
    },

    async listSessionIdsForActor(actorId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id")
        .eq("actor_id", actorId);
      if (error) throw error;
      return (data ?? []).map((r) => r.session_id).filter(Boolean);
    },

    async listWorkspacesByIdsSlim(teamId, workspaceIds) {
      if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) return [];
      const rows = await chunkedIn(workspaceIds, async (chunk) => {
        const { data, error } = await supabase
          .from("workspaces")
          .select("id, name, path, agent_id, archived")
          .eq("team_id", teamId)
          .in("id", chunk);
        if (error) throw error;
        return data ?? [];
      });
      // `archived` is one of the rules a session seat holds a workspace to
      // (assertExplicitWorkspaceBindings). `agentId` says who registered the
      // row: the desktop names only its own daemon's rows when creating an app
      // session, because a Cloud API from before shared-path seats refuses any
      // other row there and fails the whole create (#1430). The daemon has read
      // both from this response all along and been handed its defaults.
      return rows.map((row) => ({
        id: row.id,
        name: row.name ?? null,
        path: row.path ?? null,
        agentId: row.agent_id ?? null,
        archived: row.archived === true,
      }));
    },

    // --- Sessions CRUD (single-session ops; list uses listSessions above) ---

    async getSession(sessionId, { teamId = null }: any = {}) {
      // `teamId` is supplied by GET /v1/sessions/:sessionId, where it is
      // required. It stays optional on this method because the internal callers
      // below (joinSession, createSession) already know the row is theirs and
      // have no team in hand at that point.
      let query = supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("id", sessionId);
      if (teamId) query = query.eq("team_id", teamId);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data ? mapSessionFull(data) : null;
    },

    async joinSession(sessionId) {
      // SECURITY DEFINER RPC: verifies team membership and inserts the caller as
      // a participant, bypassing the participant-only RLS that would otherwise
      // hide the session and block self-insert. Idempotent.
      const { data, error } = await supabase.rpc("join_session", { p_session_id: sessionId });
      if (error) {
        if (error.code === "P0002") throw new ApiError(404, "not_found", "session not found");
        if (error.code === "42501") throw new ApiError(403, "forbidden", "not a member of this session's team");
        throw error;
      }
      // The caller is now a participant, so RLS lets getSession read the row.
      const session = await this.getSession(sessionId);
      if (!session) throw new ApiError(404, "not_found", "session not found");
      if (data === true) scheduleSessionParticipantsChanged(sessionId);
      return session;
    },

    async createSession(input) {
      // The frontend createSessionShell path supplies a client-generated id
      // plus an additionalActorIds list. Insert the session row directly and
      // bootstrap participants. The `create_session` RPC isn't used because
      // it requires `idea_id` (NOT NULL via legacy schema gated behind
      // newer migrations) and assumes the caller as the only seat.
      const id = input.id ?? randomUUID();
      // AUTHZ: created_by is ALWAYS resolved server-side from the authenticated
      // caller scoped to the target team. Any client-supplied
      // `input.createdByActorId` is ignored — a multi-team user's client can
      // send the wrong team's member actor id (stale current-team value),
      // which the `sessions` INSERT RLS WITH CHECK
      // (`created_by_actor_id = current_actor_id_for_team(team_id)`) then
      // rejects with a 403. Deriving it here guarantees the row always
      // satisfies RLS regardless of what the client sends.
      const { data: userData, error: userErr } = await getCurrentUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // A person opens it as their member actor. An agent account (a daemon
      // opening a session with `amuxd session create`) has no member actor in
      // the team, only its agent one, which the INSERT policy accepts the same
      // way: it checks `current_actor_id_for_team`, whatever the actor type.
      const resolved =
        (await this.resolveCurrentMemberActor(input.teamId, userId)) ??
        (await this.resolveCurrentActor(input.teamId, userId));
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByActorId = resolved.id;
      const additionalIds = Array.isArray(input.additionalActorIds) ? input.additionalActorIds : [];
      const participantIds = Array.isArray(input.participantActorIds) ? input.participantActorIds : [];
      const overrideByActorId =
        input.workspaceByActorId && typeof input.workspaceByActorId === "object"
          ? input.workspaceByActorId
          : {};
      await assertExplicitWorkspaceBindings(supabase, input.teamId, overrideByActorId);
      const insertRow: any = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        idea_id: input.ideaId ?? null,
        created_by_actor_id: createdByActorId,
      };
      // App-linked sessions carry app_id so listAppSessions / the app workspace
      // can resolve them. Omitted for plain
      // sessions so the column stays NULL.
      if (input.appId) insertRow.app_id = input.appId;
      // The contract names this `primaryAgentActorId` (iOS sends that); Expo
      // still sends the older `primaryAgentId`. Accept both, contract first.
      const primaryAgentId = input.primaryAgentActorId ?? input.primaryAgentId;
      if (primaryAgentId) insertRow.primary_agent_id = primaryAgentId;
      const { data, error } = await supabase
        .from("sessions")
        .insert(insertRow)
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (error) throw error;

      const seedActorIds = Array.from(
        new Set(
          [
            createdByActorId,
            ...additionalIds,
            ...participantIds,
          ].filter((x) => typeof x === "string" && x.length > 0),
        ),
      );
      if (seedActorIds.length > 0) {
        const workspaceByActor = await workspaceIdByAgentActor(
          supabase,
          seedActorIds,
          overrideByActorId,
        );
        const rows = seedActorIds.map((actorId) =>
          participantSeedRow(id, actorId, workspaceByActor.get(actorId) ?? null),
        );
        const { error: partError } = await supabase
          .from("session_participants")
          .upsert(rows, { onConflict: "session_id,actor_id", ignoreDuplicates: true });
        if (partError) throw partError;
        const participantWorkspaces = await participantWorkspacesFromBindings(
          supabase,
          workspaceByActor,
        );
        return {
          ...mapSessionFull(data),
          sessionId: id,
          participantWorkspaces,
        };
      }
      return { ...mapSessionFull(data), sessionId: id, participantWorkspaces: {} };
    },

    async patchSession(sessionId, patch) {
      const rest: any = {};
      if (patch.summary !== undefined) rest.summary = patch.summary;
      if (patch.archivedAt !== undefined) rest.archived_at = patch.archivedAt;
      if (patch.mode !== undefined) rest.mode = patch.mode;
      const lockTitle = patch.titleLocked === true && typeof patch.title === "string";
      const generatedTitle = typeof patch.title === "string" && !lockTitle;

      if (lockTitle) {
        const { data, error } = await supabase
          .from("sessions")
          .update({ ...rest, title: patch.title, title_locked: true })
          .eq("id", sessionId)
          .select(SESSION_FULL_COLUMNS)
          .maybeSingle();
        if (error) throw error;
        return data ? { ...mapSessionFull(data), titleLocked: true, titleApplied: true } : null;
      }

      if (generatedTitle) {
        // One UPDATE ... WHERE id AND title_locked = false. A rename that
        // commits first matches zero rows; the lock stays set.
        const { data, error } = await supabase.rpc("apply_generated_session_title", {
          p_session_id: sessionId,
          p_title: patch.title,
        });
        if (error) throw error;
        const written = Array.isArray(data) ? data[0] : data;
        if (!written) return null;
        if (Object.keys(rest).length > 0) {
          const { error: restError } = await supabase
            .from("sessions")
            .update(rest)
            .eq("id", sessionId);
          if (restError) throw restError;
        }
        const current = await this.getSession(sessionId);
        if (!current) return null;
        return {
          ...current,
          title: written.title ?? current.title,
          titleLocked: written.title_locked === true,
          titleApplied: written.applied === true && (written.title ?? current.title) === patch.title,
        };
      }

      if (Object.keys(rest).length === 0) {
        return this.getSession(sessionId);
      }
      const { data, error } = await supabase
        .from("sessions")
        .update(rest)
        .eq("id", sessionId)
        .select(SESSION_FULL_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? mapSessionFull(data) : null;
    },

    async markSessionViewed(sessionId, lastReadMessageId = null) {
      const { error } = await supabase.rpc("mark_current_actor_session_viewed", {
        p_session_id: sessionId,
        p_last_read_message_id: lastReadMessageId ?? null,
      });
      if (error) throw error;

      // Fan out a read ping so the caller's other devices clear attention
      // badges. Same inbox/<uid> topic as message pings; best-effort.
      if (publishSessionParticipantInbox) {
        void (async () => {
          const { data: auth, error: authErr } = await getCurrentUser();
          if (authErr || !auth?.user?.id) return;
          const { data: session, error: sessionErr } = await supabase
            .from("sessions")
            .select("team_id, source, app_id")
            .eq("id", sessionId)
            .maybeSingle();
          if (sessionErr || !session) return;
          const source = session.source ?? "user";
          const kind =
            source === "cron"
              ? "cron"
              : source === "gateway"
                ? "channel"
                : session.app_id
                  ? "app"
                  : "regular";
          await publishSessionParticipantInbox(
            `inbox/${auth.user.id}`,
            buildSessionReadInboxPayload({
              sessionId,
              teamId: session.team_id ?? null,
              kind,
            }),
          );
        })().catch((err: unknown) => {
          console.error("[inbox] read ping failed (swallowed):", err);
        });
      }
    },

    /**
     * Drop the caller's read marker so the session derives as unread again (no
     * marker reads as "never read" in `list_current_actor_sessions`).
     *
     * `session_read_markers` has insert, select and update policies but no
     * DELETE one, so this used to run on the caller's token, match nothing and
     * still answer 204 - "mark as unread" did nothing on any client. The delete
     * goes through the service role, pinned to the caller's own actor in the
     * session's team, which is the row an "own marker" policy would have named.
     */
    async markSessionUnread(sessionId) {
      const { data: session, error: sessionErr } = await supabase
        .from("sessions")
        .select("id, team_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionErr) throw sessionErr;
      if (!session) throw new ApiError(404, "not_found", "session not found");
      const callerActorId = await requireCallerTeamMemberActor(String(session.team_id));
      const admin = await serviceRoleClient("clear a session read marker");
      const { error } = await admin
        .from("session_read_markers")
        .delete()
        .eq("session_id", sessionId)
        .eq("actor_id", callerActorId);
      if (error) throw error;
    },

    async getSessionByAcp(acpSessionId) {
      const { data, error } = await supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("acp_session_id", acpSessionId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // The amuxd daemon (get_gateway_session_by_acp_id) deserializes this into
      // { sessionId: required String, gatewaySessionId: Option<String> } and
      // uses gatewaySessionId as the chat binding for the per-session MCP
      // config. mapSessionFull alone exposes `id`/`binding` (not the camelCase
      // names the daemon expects), so surface both explicitly.
      return {
        ...mapSessionFull(data),
        sessionId: data.id,
        gatewaySessionId: data.binding ?? null,
      };
    },

    async ensureGatewaySession(input) {
      const { data, error } = await supabase.rpc("ensure_gateway_session", {
        p_team_id: input.teamId,
        p_binding: input.binding,
        p_title: input.title,
        p_primary_agent_actor_id: input.primaryAgentActorId,
        p_owner_member_actor_ids: input.ownerMemberActorIds ?? [],
        p_participant_actor_ids: input.participantActorIds ?? [],
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new ApiError(502, "upstream_unavailable", "ensure_gateway_session returned no row");
      const acpSessionId = row.acp_session_id ?? row.acpSessionId ?? null;
      const sessionId = row.session_id ?? row.sessionId ?? null;
      const insertedActorIds = row.inserted_actor_ids ?? row.insertedActorIds ?? [];
      if (sessionId && Array.isArray(insertedActorIds) && insertedActorIds.length > 0) {
        scheduleSessionParticipantsChanged(sessionId);
      }
      return {
        sessionId,
        // The amuxd daemon deserializes `gatewaySessionId` as a REQUIRED field
        // and uses it as the logical ACP session id it later looks up via
        // getSessionByAcp (which queries the acp_session_id column) — so it must
        // equal acp_session_id to round-trip. Omitting it made WeCom inbound
        // messages fail with "missing field gatewaySessionId".
        gatewaySessionId: acpSessionId,
        acpSessionId,
        created: row.created === true,
      };
    },

    async detachGatewaySession(acpSessionId) {
      const { data, error } = await supabase.rpc("detach_gateway_session", {
        p_acp_session_id: acpSessionId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        sessionId: row?.session_id ?? row?.sessionId ?? null,
        detached: (row?.detached ?? row?.Detached) === true,
      };
    },

    async listGatewaySessions(input) {
      const { data, error } = await supabase.rpc("list_gateway_sessions", {
        p_team_id: input.teamId,
        p_gateway_key: input.gatewayKey,
        p_limit: input.limit ?? 20,
      });
      if (error) throw error;
      const rows: any[] = Array.isArray(data) ? data : data ? [data] : [];
      return {
        items: rows.map((r) => ({
          sessionId: r.session_id ?? r.sessionId ?? null,
          acpSessionId: r.acp_session_id ?? r.acpSessionId ?? null,
          title: r.title ?? "",
          isCurrent: (r.is_current ?? r.isCurrent) === true,
          lastMessageAt: r.last_message_at ?? r.lastMessageAt ?? null,
          createdAt: r.created_at ?? r.createdAt ?? null,
        })),
      };
    },

    async attachGatewaySession(input) {
      const { data, error } = await supabase.rpc("attach_gateway_session", {
        p_binding: input.binding,
        p_session_id: input.sessionId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        sessionId: row?.session_id ?? row?.sessionId ?? null,
        acpSessionId: row?.acp_session_id ?? row?.acpSessionId ?? null,
        attached: (row?.attached ?? row?.Attached) === true,
      };
    },

    async createCronSession(input) {
      // Cron sessions are plain `mode='collab'` sessions with no idea_id and
      // a marker in `summary` or metadata. The supabase create_session RPC
      // requires an idea_id, so we insert directly to bypass that constraint.
      const id = input.id ?? randomUUID();
      const insertRow: any = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: "collab",
        primary_agent_id: input.primaryAgentActorId,
        source: "cron",
        cron_job_id: input.cronJobId ?? null,
      };
      if (input.createdByActorId) insertRow.created_by_actor_id = input.createdByActorId;
      else insertRow.created_by_actor_id = input.primaryAgentActorId;
      const { data, error } = await supabase
        .from("sessions")
        .insert(insertRow)
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (error) throw error;
      // Bootstrap primary agent as participant, with the folder it will run
      // in. Without this the desktop file tree has nothing to adopt and shows
      // "Agent 尚未启动" even after the cron turn has already replied.
      const overrideByActorId: Record<string, string> = {};
      if (typeof input.workspaceId === "string" && input.workspaceId.trim()) {
        overrideByActorId[input.primaryAgentActorId] = input.workspaceId.trim();
      }
      const workspaceByActor = await workspaceIdByAgentActor(
        supabase,
        [input.primaryAgentActorId],
        overrideByActorId,
      );
      const { error: partError } = await supabase
        .from("session_participants")
        .upsert(
          [
            participantSeedRow(
              id,
              input.primaryAgentActorId,
              workspaceByActor.get(input.primaryAgentActorId) ?? null,
            ),
          ],
          // ON CONFLICT DO NOTHING - see createThread: no UPDATE policy here.
          { onConflict: "session_id,actor_id", ignoreDuplicates: true },
        );
      if (partError) throw partError;

      // Mirror gateway sessions: add human admins of the primary agent so
      // desktop users can open cron run history via "查看对话". Without this,
      // sessions_select_if_participant_or_creator hides the row from members
      // who are not the agent actor (see 202605060001_sessions_select_only_participants).
      const { data: adminRows, error: adminErr } = await supabase.rpc(
        "list_agent_admin_member_actor_ids",
        { p_agent_actor_id: input.primaryAgentActorId },
      );
      if (adminErr) throw adminErr;
      const adminActorIds = (adminRows ?? [])
        .map((row) => (typeof row === "string" ? row : row?.member_actor_id))
        .filter((id) => typeof id === "string" && id.length > 0);
      if (adminActorIds.length > 0) {
        const { error: adminPartErr } = await supabase
          .from("session_participants")
          .upsert(
            adminActorIds.map((actor_id) => ({ session_id: id, actor_id })),
            { onConflict: "session_id,actor_id", ignoreDuplicates: true },
          );
        if (adminPartErr) throw adminPartErr;
      }

      return { sessionId: data.id, ...mapSessionFull(data) };
    },

    // --- Session members (participants) ---

    async listSessionParticipants(sessionId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id, actor_id, role, joined_at, workspace_id, model, last_processed_message_id")
        .eq("session_id", sessionId);
      if (error) throw error;
      const rows = data ?? [];
      const actorIds = rows.map((r) => r.actor_id).filter(Boolean);
      let actorsById = new Map();
      if (actorIds.length > 0) {
        const actors = await chunkedIn(actorIds, async (chunk) => {
          const { data, error: actorsErr } = await supabase
            .from("actor_directory")
            .select("id, team_id, actor_type, display_name, avatar_url")
            .in("id", chunk);
          if (actorsErr) throw actorsErr;
          return data ?? [];
        });
        actorsById = new Map(actors.map((a) => [a.id, a]));
      }
      const items = rows.map((row) => {
        const actor = actorsById.get(row.actor_id);
        return {
          sessionId: row.session_id,
          actorId: row.actor_id,
          role: row.role ?? null,
          joinedAt: row.joined_at ?? null,
          // Agent's working state for this session (ADR-0005); null on member
          // rows. Replaces reading `agent_runtimes` from clients.
          workspaceId: row.workspace_id ?? null,
          model: row.model ?? null,
          lastProcessedMessageId: row.last_processed_message_id ?? null,
          teamId: actor?.team_id ?? null,
          actorType: actor?.actor_type ?? null,
          displayName: actor?.display_name ?? null,
          avatarUrl: actor?.avatar_url ?? null,
        };
      });
      return { items };
    },

    async listSessionRoster(sessionId) {
      const { data: sessionRow, error: sessionErr } = await supabase
        .from("sessions")
        .select("id, team_id, title, app_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionErr) throw sessionErr;
      if (!sessionRow) throw new ApiError(404, "not_found", "session not found");

      const caller = await this.resolveCallerActorForTeam(sessionRow.team_id);
      const callerActorId = caller?.id ?? null;
      if (!callerActorId) {
        throw new ApiError(401, "missing_identity", "authentication required");
      }

      const { data: seats, error: seatsErr } = await supabase
        .from("session_participants")
        .select("session_id, actor_id")
        .eq("session_id", sessionId);
      if (seatsErr) throw seatsErr;
      const participantRows = seats ?? [];
      if (!participantRows.some((seat) => seat.actor_id === callerActorId)) {
        throw new ApiError(403, "forbidden", "not a participant in this session");
      }

      const actorIds = participantRows.map((seat) => seat.actor_id).filter(Boolean);
      let actorsById = new Map();
      if (actorIds.length > 0) {
        const actorRows = await chunkedIn(actorIds, async (chunk) => {
          const { data, error } = await supabase
            .from("actors")
            .select("id, display_name, actor_type")
            .in("id", chunk);
          if (error) throw error;
          return data ?? [];
        });
        actorsById = new Map(actorRows.map((row) => [row.id, row]));
      }

      let selfAgent = null;
      const callerActor = actorsById.get(callerActorId);
      if (callerActor?.actor_type === "agent") {
        const { data: agentRow, error: agentErr } = await supabase
          .from("agents")
          .select("visibility, owner_member_id")
          .eq("id", callerActorId)
          .maybeSingle();
        if (agentErr) throw agentErr;
        if (agentRow) {
          let ownerDisplayName = null;
          if (agentRow.owner_member_id) {
            const ownerFromRoster = actorsById.get(agentRow.owner_member_id);
            if (ownerFromRoster?.display_name) {
              ownerDisplayName = ownerFromRoster.display_name;
            } else {
              const { data: ownerRow, error: ownerErr } = await supabase
                .from("actors")
                .select("display_name")
                .eq("id", agentRow.owner_member_id)
                .maybeSingle();
              if (ownerErr) throw ownerErr;
              ownerDisplayName = ownerRow?.display_name ?? null;
            }
          }
          selfAgent = {
            visibility: agentRow.visibility ?? null,
            ownerMemberId: agentRow.owner_member_id ?? null,
            ownerDisplayName,
          };
        }
      }

      // App workspaces need a small, session-scoped control-plane snapshot in
      // the agent's system prompt. Read it only after proving that the caller
      // is seated in this session, and only for an agent caller. The service
      // role is intentional: personal apps are hidden from daemon actors by
      // app RLS, even when that daemon is running the app's own session.
      //
      // This is a deliberately safe projection. It contains no env values,
      // cron header/body values, data rows, file names, DNS tokens or secrets.
      let appContext = null;
      if (sessionRow.app_id && callerActor?.actor_type === "agent") {
        try {
          const admin = await serviceRoleClient("read app workspace context for a seated agent");
          const { data: appRow, error: appErr } = await admin
            .from("apps")
            .select(`${APP_COLUMNS}, custom_domain, custom_domain_verified_at, storage_bytes, storage_quota_bytes, app_links!inner(team_id)`)
            .eq("id", sessionRow.app_id)
            .eq("app_links.team_id", sessionRow.team_id)
            .maybeSingle();
          if (appErr) throw appErr;

          if (appRow) {
            const [envResult, cronResult] = await Promise.all([
              admin
                .from("app_env_vars")
                .select("key, is_secret")
                .eq("app_id", appRow.id)
                .order("key", { ascending: true }),
              admin
                .from("app_cron_jobs")
                .select("name, enabled, schedule_expr, timezone, method, path, headers")
                .eq("app_id", appRow.id)
                .order("created_at", { ascending: true }),
            ]);
            if (envResult.error) throw envResult.error;
            if (cronResult.error) throw cronResult.error;

            // With TeamClu's fields (visibility), as /v1/apps answers it.
            const app = await this.presentApp(appRow);
            const customDomainVerified = Boolean(appRow.custom_domain_verified_at);
            const canonicalUrl = customDomainVerified && appRow.custom_domain
              ? `https://${appRow.custom_domain}`
              : (app.publicUrl ?? app.fcEndpoint ?? null);
            const deployedType = appRow.deployed_type ?? appRow.type;
            const quotaBytes = appRow.storage_quota_bytes ?? null;
            const storageBytes = appRow.storage_bytes ?? null;

            appContext = {
              snapshotAt: new Date().toISOString(),
              id: app.id,
              name: app.name,
              type: app.type,
              visibility: app.visibility,
              canonicalUrl,
              provisionStatus: app.provisionStatus,
              fcStatus: app.fcStatus,
              deployment: {
                gitCommitSha: app.gitCommitSha,
                // Unlike mapApp's compatibility fallback, null here means
                // exactly "no successful deploy has recorded this yet".
                runtime: appRow.runtime ?? null,
                startSpec: appRow.start_spec ?? null,
                typePendingRedeploy: app.typePendingRedeploy,
                envPendingRedeploy: app.envPendingRedeploy,
                authModePendingRedeploy: app.authModePendingRedeploy,
              },
              auth: {
                mode: app.authMode,
                audience: app.authAudience,
                scope: app.authScope,
                rules: app.authRules,
              },
              database: {
                configured: needsDatabase(appRow.type),
                live: app.fcStatus === "live" && needsDatabase(deployedType),
              },
              storage: {
                controlPlaneAvailable: Boolean(appStorage && readAppsCloudApiUrl()),
                overQuota:
                  typeof quotaBytes === "number" &&
                  typeof storageBytes === "number" &&
                  storageBytes >= quotaBytes,
              },
              environment: {
                keys: (envResult.data ?? []).map((row) => ({
                  key: row.key,
                  isSecret: Boolean(row.is_secret),
                })),
              },
              cronJobs: (cronResult.data ?? []).map((row) => ({
                name: row.name,
                enabled: Boolean(row.enabled),
                schedule: row.schedule_expr,
                timezone: row.timezone,
                method: row.method,
                path: row.path,
                headerNames:
                  row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
                    ? Object.keys(row.headers).sort()
                    : [],
              })),
              customDomain: {
                domain: appRow.custom_domain ?? null,
                verified: customDomainVerified,
              },
            };
          }
        } catch (error) {
          // App context is useful but must never take the session identity
          // prompt down with it. The agent can still run `amuxd app show`.
          console.warn(`[session-roster] app context unavailable for ${sessionId}: ${String(error)}`);
        }
      }

      return {
        sessionId,
        callerActorId,
        title: sessionRow.title ?? null,
        selfAgent,
        appContext,
        items: participantRows.map((seat) => {
          const actor = actorsById.get(seat.actor_id);
          return {
            actorId: seat.actor_id,
            displayName: actor?.display_name ?? null,
            kind: actor?.actor_type ?? null,
            isSelf: seat.actor_id === callerActorId,
          };
        }),
      };
    },

    async upsertSessionParticipant(sessionId, input) {
      const row: any = {
        session_id: sessionId,
        actor_id: input.actorId,
      };
      if (input.role !== undefined) row.role = input.role;
      // DO NOTHING, not DO UPDATE. `session_participants` has INSERT and
      // SELECT policies and no UPDATE one, so an upsert onto a row that
      // already existed was refused outright:
      //
      //   forbidden: new row violates row-level security policy
      //              (USING expression) for table "session_participants"
      //
      // Which is every gateway message after the first: `ensureGatewaySession`
      // already adds the sender as a participant, so the daemon's follow-up
      // join always conflicts. It warned once per message, forever, and the
      // "repaired on the next message" the daemon's comment promised could
      // never happen.
      //
      // Re-joining no longer rewrites `role`. That is the safer half of the
      // change: the caller always sends "member", so the old path quietly
      // demoted an owner on every message they sent through a channel.
      // `ignoreDuplicates` plus `select` returns only the row this call inserted.
      // An empty array is a conflict, not an error — do not chain `.single()`,
      // which turns zero rows into a PostgREST error. The read below still
      // returns the existing seat for the HTTP body.
      const { data: insertedRows, error: insertError } = await supabase
        .from("session_participants")
        .upsert(row, { onConflict: "session_id,actor_id", ignoreDuplicates: true })
        .select("session_id, actor_id, role, joined_at");
      if (insertError) throw insertError;
      const inserted = Array.isArray(insertedRows) && insertedRows.length > 0;
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id, actor_id, role, joined_at")
        .eq("session_id", sessionId)
        .eq("actor_id", input.actorId)
        .single();
      if (error) throw error;
      if (inserted) scheduleSessionParticipantsChanged(sessionId);
      return {
        sessionId: data.session_id,
        actorId: data.actor_id,
        role: data.role ?? null,
        joinedAt: data.joined_at ?? null,
      };
    },

    /**
     * The agent's catch-up cursor for this session (ADR-0005).
     *
     * Written through `writeAgentSeat`: on the caller's token this matched no
     * row and still answered 204, so the cursor never moved after the
     * ADR-0005 backfill and a restarted daemon had nothing to resume from.
     */
    async updateParticipantCursor(sessionId, actorId, { lastProcessedMessageId }) {
      await writeAgentSeat(sessionId, actorId, {
        last_processed_message_id: lastProcessedMessageId,
      }, "advance a session participant's cursor");
    },

    /**
     * Which model this agent runs on in this session.
     *
     * The column landed with the ADR-0005 migration alongside `workspace_id`
     * and the cursor, but only those two got writers: `model` was backfilled
     * from `agent_runtimes.current_model` and then never touched again, so
     * every reader trusting the ADR got a frozen value. This is that writer -
     * and it only became one once it stopped writing on the caller's token
     * (see `writeAgentSeat`).
     */
    async updateParticipantModel(sessionId, actorId, { model }) {
      await writeAgentSeat(sessionId, actorId, { model }, "record a session participant's model");
    },

    /**
     * Move an agent's seat to another folder.
     *
     * `session_participants.workspace_id` is where the file tree, runtime-start
     * and the daemon's cold paths all read an agent's folder from (ADR-0005),
     * and it used to be written only when the seat was created — with the
     * agent's default folder unless the creator named one. An app session
     * seated that way kept showing the default workspace while its agent worked
     * in the app's checkout, and nothing could move it (#1430).
     *
     * The table has no UPDATE policy, and a row-level one would hand every
     * member `role` and the cursor along with it, so the write goes through the
     * service role — after the checks such a policy would have made. The caller
     * must see the session, speak for the agent (be it, own it, or hold admin on
     * it), and name a workspace that passes the rules `createSession` applies.
     */
    async setParticipantWorkspace(sessionId, actorId, { workspaceId }) {
      const { data: session, error: sessionErr } = await supabase
        .from("sessions")
        .select("id, team_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionErr) throw sessionErr;
      if (!session) throw new ApiError(404, "not_found", "session not found");
      const teamId = String(session.team_id);
      const callerActorId = await requireCallerTeamMemberActor(teamId);
      const admin = await serviceRoleClient("move a session participant's workspace");

      const agent = await findAgent(admin, actorId);
      if (!(await callerSpeaksForAgent(admin, callerActorId, actorId, agent))) {
        throw new ApiError(
          403,
          "forbidden",
          "only the agent, its owner or one of its admins can move its workspace",
        );
      }

      await assertExplicitWorkspaceBindings(supabase, teamId, { [actorId]: workspaceId });

      const { data: seat, error: seatErr } = await admin
        .from("session_participants")
        .select("workspace_id")
        .eq("session_id", sessionId)
        .eq("actor_id", actorId)
        .maybeSingle();
      if (seatErr) throw seatErr;
      if (!seat) throw new ApiError(404, "not_found", "participant not found");
      if (seat.workspace_id === workspaceId) return;

      const { error } = await admin
        .from("session_participants")
        .update({ workspace_id: workspaceId, updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("actor_id", actorId);
      if (error) throw error;
    },

    /**
     * Link an existing session to an app (`sessions.app_id`), so it appears
     * under the app and its agent can be seated on the app's checkout. A
     * session could only be given an app when it was created; one in which an
     * agent then built an app stayed apart from it (#1885).
     *
     * The sessions UPDATE policy lets any team member write any column, with
     * no word on the app, so the write goes through the service role after the
     * checks this link needs: the caller is a member seated in the session, the
     * app is one they can see (RLS on their own token) and sits in the
     * session's team, and the session is a regular one with no app yet. The
     * conditional update makes a concurrent link lose cleanly. Linking to the
     * app it already has changes nothing.
     */
    async linkSessionApp(sessionId, { appId }) {
      const { data: session, error: sessionErr } = await supabase
        .from("sessions")
        .select("id, team_id, app_id, source")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionErr) throw sessionErr;
      if (!session) throw new ApiError(404, "not_found", "session not found");
      if (session.app_id === appId) return;
      if (session.app_id) {
        throw new ApiError(409, "session_already_linked", "this session already belongs to an app");
      }
      if ((session.source ?? "user") !== "user") {
        throw new ApiError(409, "session_not_linkable", "only a regular session can be linked to an app");
      }
      const teamId = String(session.team_id);
      const callerActorId = await requireCallerTeamMemberActor(teamId);
      const admin = await serviceRoleClient("link a session to an app");

      const { data: seat, error: seatErr } = await admin
        .from("session_participants")
        .select("actor_id")
        .eq("session_id", sessionId)
        .eq("actor_id", callerActorId)
        .maybeSingle();
      if (seatErr) throw seatErr;
      if (!seat) {
        throw new ApiError(403, "forbidden", "only a member of the session can link it to an app");
      }

      // Visibility on the caller's own token: an app they cannot see is not
      // theirs to link, and reads as absent.
      const { data: app, error: appErr } = await supabase
        .from("apps")
        .select("id")
        .eq("id", appId)
        .maybeSingle();
      if (appErr) throw appErr;
      if (!app) throw new ApiError(404, "not_found", "app not found");
      const { data: link, error: linkErr } = await supabase
        .from("app_links")
        .select("team_id")
        .eq("app_id", appId)
        .maybeSingle();
      if (linkErr) throw linkErr;
      if (!link || String(link.team_id) !== teamId) {
        throw new ApiError(409, "app_in_other_team", "the app is not in this session's team");
      }

      const { data: updated, error: updErr } = await admin
        .from("sessions")
        .update({ app_id: appId, updated_at: new Date().toISOString() })
        .eq("id", sessionId)
        .is("app_id", null)
        .select("id")
        .maybeSingle();
      if (updErr) throw updErr;
      if (updated) return;
      // Someone linked it between the read and the write.
      const { data: now, error: nowErr } = await admin
        .from("sessions")
        .select("app_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (nowErr) throw nowErr;
      if (now?.app_id === appId) return;
      throw new ApiError(409, "session_already_linked", "this session already belongs to an app");
    },

    /**
     * Take someone out of a session.
     *
     * The table has no DELETE policy, so this used to run on the caller's token
     * and match nothing: PostgREST reports zero rows as success, the route
     * answered 204, and the participant was back on the next roster read — an
     * agent swiped away in the member sheet reappeared at once. As with
     * `setParticipantWorkspace`, the delete goes through the service role after
     * the checks a policy would have made.
     *
     * The caller must see the session. Removing an agent additionally takes the
     * session's creator or someone who speaks for the agent (it, its owner, one
     * of its admins): being in a session is not licence to drop someone else's
     * agent from it. A human seat only needs the first check, matching the
     * clients, which let any member remove any other member.
     */
    async removeSessionParticipant(sessionId, actorId) {
      const { data: session, error: sessionErr } = await supabase
        .from("sessions")
        .select("id, team_id, created_by_actor_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionErr) throw sessionErr;
      if (!session) throw new ApiError(404, "not_found", "session not found");
      const callerActorId = await requireCallerTeamMemberActor(String(session.team_id));
      const admin = await serviceRoleClient("remove a session participant");

      const agent = await findAgent(admin, actorId);
      if (
        agent
        && session.created_by_actor_id !== callerActorId
        && !(await callerSpeaksForAgent(admin, callerActorId, actorId, agent))
      ) {
        throw new ApiError(
          403,
          "forbidden",
          "only the session's creator, the agent, its owner or one of its admins can remove it",
        );
      }

      // Remember a removed human's login before the row is gone. Agents are
      // not inbox recipients even when they carry a user_id.
      const { data: seatActor, error: seatActorErr } = await admin
        .from("actors")
        .select("actor_type, user_id")
        .eq("id", actorId)
        .maybeSingle();
      if (seatActorErr) throw seatActorErr;
      const removedUserId = removedMemberUserId(seatActor);

      // Asking for the deleted rows back is what tells a removal apart from a
      // miss; without it a wrong id is as silent as the RLS denial was.
      const { data: removed, error } = await admin
        .from("session_participants")
        .delete()
        .eq("session_id", sessionId)
        .eq("actor_id", actorId)
        .select("actor_id");
      if (error) throw error;
      if (!removed?.length) throw new ApiError(404, "not_found", "participant not found");
      scheduleSessionParticipantsChanged(sessionId, removedUserId);
    },

    // --- Actor reads + external + access (member-access table) ---

    async getActor(actorId) {
      const { data, error } = await supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("id", actorId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // Same roles as listTeamActors: actor_directory has no roles column and its
      // team_role is the legacy team_members.role, so without this a detail view
      // reads "member" for an org admin the list shows correctly.
      const mapped = mapDirectoryActor(data);
      const [actor] = mapped.teamId
        ? await enrichActorsWithOrgRoles(supabase, mapped.teamId, [mapped])
        : [mapped];
      const { data: versions, error: vErr } = await supabase
        .from("actor_client_versions")
        .select("client_type, version, device_id, build, last_reported_at")
        .eq("actor_id", actorId)
        .order("client_type", { ascending: true })
        .order("last_reported_at", { ascending: false });
      if (vErr) throw vErr;
      return {
        ...actor,
        clientVersions: (versions ?? []).map((v) => ({
          clientType: v.client_type,
          version: v.version,
          deviceId: v.device_id,
          build: v.build ?? null,
          lastReportedAt: v.last_reported_at,
        })),
      };
    },

    async upsertExternalActor(input) {
      const { data, error } = await supabase.rpc("upsert_external_actor", {
        p_team_id: input.teamId,
        p_source: input.source,
        p_source_id: input.sourceId,
        p_display_name: input.displayName,
      });
      if (error) throw error;
      // RPC returns the actor uuid scalar.
      const actorId = typeof data === "string" ? data : (Array.isArray(data) ? data[0] : null);
      if (!actorId) throw new ApiError(502, "upstream_unavailable", "upsert_external_actor returned no id");
      return { actorId };
    },

    async checkAgentPermission(agentActorId, actorId) {
      const { data, error } = await supabase.rpc("check_agent_permission", {
        p_agent_id: agentActorId,
        p_actor_id: actorId,
      });
      if (error) throw error;
      // RPC returns a text scalar (permission_level) or null.
      const role = typeof data === "string" && data.length > 0 ? data : null;
      return { allowed: role !== null, role };
    },

    async grantAgentAccess(agentActorId, { actorId, role }) {
      const { data, error } = await supabase
        .from("agent_member_access")
        .upsert(
          {
            agent_id: agentActorId,
            member_id: actorId,
            permission_level: role,
          },
          { onConflict: "agent_id,member_id" },
        )
        .select("id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at")
        .single();
      if (error) throw error;
      return {
        id: data.id,
        agentActorId: data.agent_id,
        actorId: data.member_id,
        role: data.permission_level,
        grantedByMemberId: data.granted_by_member_id ?? null,
        createdAt: data.created_at ?? null,
        updatedAt: data.updated_at ?? null,
      };
    },

    async revokeAgentAccess(agentActorId, actorId) {
      const { error } = await supabase
        .from("agent_member_access")
        .delete()
        .eq("agent_id", agentActorId)
        .eq("member_id", actorId);
      if (error) throw error;
    },

    async listAgentAdminMembers(agentActorId) {
      const { data, error } = await supabase.rpc("list_agent_admin_member_actor_ids", {
        p_agent_actor_id: agentActorId,
      });
      if (error) throw error;
      const items = (data ?? [])
        .map((row) => (typeof row === "string" ? row : row?.member_actor_id))
        .filter((id) => typeof id === "string" && id.length > 0);
      return { items };
    },

    // --- Runtime liveness ---

    async heartbeat() {
      // Probe + update last_active_at so clients see the daemon as online.
      const { error } = await supabase.rpc("update_actor_last_active");
      if (error) throw error;
    },

    // --- Actor agent management (RPCs) ---

    async listConnectedAgents(teamId) {
      const { data, error } = await supabase.rpc("list_connected_agents", { p_team_id: teamId });
      if (error) throw error;
      const items = (data ?? []).map((row) => {
        const id = row.id ?? row.agent_id;
        return {
          id,
          teamId: row.team_id ?? teamId,
          kind: row.actor_type ?? "agent",
          displayName: row.display_name ?? null,
          avatarUrl: row.avatar_url ?? null,
          userId: row.user_id ?? null,
          teamRole: row.team_role ?? null,
          memberStatus: row.member_status ?? null,
          agentStatus: row.agent_status ?? null,
          agentTypes: row.agent_types ?? null,
          defaultAgentType: row.default_agent_type ?? null,
          defaultWorkspaceId: row.default_workspace_id ?? null,
          lastActiveAt: row.last_active_at ?? null,
          createdAt: row.created_at ?? null,
          updatedAt: row.updated_at ?? null,
          agentId: row.agent_id ?? id,
          // Fields the list_connected_agents RPC computes that clients need
          // (iOS ConnectedAgent: permission level, visibility, ownership).
          permissionLevel: row.permission_level ?? null,
          visibility: row.visibility ?? null,
          isOwner: row.is_owner === true,
        };
      })
        .filter((row) => typeof row.id === "string" && row.id.length > 0)
        // The list_connected_agents RPC has no status predicate, so the filter
        // lands here rather than in a migration.
        .filter((row) => isListableAgentStatus(row.agentStatus));
      return { items };
    },

    async findAgentForDevice(teamId, input) {
      const { data, error } = await supabase.rpc("find_agent_for_device", {
        p_team_id: teamId,
        p_device_id: input.deviceId,
      });
      if (error) throw error;
      // Zero rows is the normal "this machine is new here" answer, not a fault.
      const row = Array.isArray(data) ? data[0] : data;
      return {
        agentId: row?.agent_id ?? null,
        displayName: row?.display_name ?? null,
      };
    },

    async adoptLegacyAgentDevice(teamId, input) {
      const { data, error } = await supabase.rpc("adopt_legacy_agent_device", {
        p_team_id: teamId,
        p_device_id: input.deviceId,
        p_agent_id: input.agentId,
      });
      if (error) {
        if (error.code === "22023") {
          throw new ApiError(400, "validation_failed", error.message ?? "invalid device agent request");
        }
        if (error.code === "42501") {
          throw new ApiError(403, "forbidden", error.message ?? "team membership required");
        }
        throw error;
      }
      // Zero rows means the agent was not eligible. That is a normal answer,
      // not a fault: the desktop then keeps the install card.
      const row = Array.isArray(data) ? data[0] : data;
      return {
        agentId: row?.agent_id ?? null,
        displayName: row?.display_name ?? null,
      };
    },

    async ensureAgentForDevice(teamId, input) {
      // The RPC owns the whole decision: advisory lock on (team, device), find
      // the caller-owned agent for this machine or create it (visibility comes
      // from the column default, 'personal'), then mint the one-shot invite by
      // delegating to create_team_invite. Doing the lookup here instead would
      // need device_id exposed through list_connected_agents, which would hand
      // every team member a fingerprint of everyone else's machines.
      const { data, error } = await supabase.rpc("ensure_agent_for_device", {
        p_team_id: teamId,
        p_device_id: input.deviceId,
        p_display_name: input.displayName,
      });
      if (error) {
        if (error.code === "22023") {
          throw new ApiError(400, "validation_failed", error.message ?? "invalid device agent request");
        }
        // 42501: the caller is not a member of this team.
        if (error.code === "42501") {
          throw new ApiError(403, "forbidden", error.message ?? "team membership required");
        }
        throw error;
      }
      const row = requiredRow(data, "actors.ensureAgentForDevice");
      return {
        agentId: requiredString(row.agent_id, "actors.ensureAgentForDevice", "agent_id"),
        token: requiredString(row.token, "actors.ensureAgentForDevice", "token"),
        expiresAt: row.expires_at ?? null,
        created: row.created === true,
      };
    },

    async shareAgentToTeam(agentActorId) {
      const { error } = await supabase.rpc("share_agent_to_team", { p_agent_id: agentActorId });
      if (error) throw error;
    },

    async makeAgentPersonal(agentActorId) {
      const { error } = await supabase.rpc("make_agent_personal", { p_agent_id: agentActorId });
      if (error) throw error;
    },

    async updateOwnedAgentProfile(agentActorId, patch) {
      const { error } = await supabase.rpc("update_owned_agent_profile", {
        p_agent_id: agentActorId,
        p_display_name: patch.displayName ?? null,
        p_visibility: patch.visibility ?? null,
      });
      if (error) throw error;
    },

    async updateAgentDefaults(agentActorId, patch) {
      const { error } = await supabase.rpc("update_agent_defaults", {
        p_agent_id: agentActorId,
        p_default_workspace_id: patch.defaultWorkspaceId ?? null,
        p_agent_kind: patch.agentKind ?? null,
        p_default_agent_type: patch.defaultAgentType ?? null,
      });
      if (error) throw error;
    },

    async listAgentAccess(agentActorId) {
      const { data, error } = await supabase
        .from("agent_member_access")
        .select("id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at")
        .eq("agent_id", agentActorId)
        .order("permission_level", { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      const memberIds = [...new Set(rows.map((row) => row.member_id))];
      const memberInfo = new Map();
      if (memberIds.length > 0) {
        const members = await chunkedIn(memberIds, async (chunk) => {
          const { data, error: memberError } = await supabase
            .from("actor_directory")
            .select("id, display_name, actor_type, last_active_at")
            .in("id", chunk);
          if (memberError) throw memberError;
          return data ?? [];
        });
        for (const member of members) {
          memberInfo.set(member.id, member);
        }
      }
      const items = rows.map((row) => {
        const member = memberInfo.get(row.member_id);
        return {
          id: row.id,
          agentId: row.agent_id,
          agentActorId: row.agent_id,
          actorId: row.member_id,
          memberId: row.member_id,
          memberName: member?.display_name || row.member_id,
          actorType: member?.actor_type ?? null,
          lastActiveAt: member?.last_active_at ?? null,
          role: row.permission_level,
          permissionLevel: row.permission_level,
          grantedByMemberId: row.granted_by_member_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
      return { items };
    },


    async listAgentDefaults(agentIds) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const rows = await chunkedIn(agentIds, async (chunk) => {
        const { data, error } = await supabase
          .from("agents")
          .select("id, agent_types, default_agent_type, default_workspace_id")
          .in("id", chunk);
        if (error) throw error;
        return data ?? [];
      });
      return rows.map((row) => ({
        id: row.id,
        agentTypes: Array.isArray(row.agent_types) ? row.agent_types : null,
        defaultAgentType: row.default_agent_type ?? null,
        // The amuxd daemon reads this to resolve the gateway runtime's working
        // directory from its own agent's default workspace.
        defaultWorkspaceId: row.default_workspace_id ?? null,
      }));
    },





    // --- Apps domain: app-platform/service/apps.ts (P2.4a) ---
    ...makeAppsRepo({
      supabase,
      serviceRoleClient,
      getCurrentUser,
      forge,
      appView,
      startDeploy,
      finalizeDeploy,
      deployUnavailableReason,
      gotrue,
      gotrueUnavailableReason,
      appData,
      appDataUnavailableReason,
      appStorage,
      appStorageUnavailableReason,
      appLogs,
      appLogsUnavailableReason,
      readRuntimeCatalog,
      readAppFunction,
      validateAppOrigin,
      readAppOriginSecurity,
      applyKeysetCursor,
      appEnvSecretKind,
      tenant: teamCluAppTenant({ supabase, serviceRoleClient, getCurrentUser, archiveSessionsForWorkspace }),
    }),

    // --- TeamClu's side of apps: teamclu-apps/repo.ts (P2.4b) ---
    ...makeTeamCluAppsRepo({
      supabase,
      serviceRoleClient,
      getCurrentUser,
      forge,
      publishSessionParticipantInbox,
    }),

    // ─── Team skills registry ────────────────────────────────────────────────
    // docs/architecture/team-skills-registry.md
    //
    // Authz lives in RLS here (see 20260806000000_team_skills_registry.sql), so
    // these are thin. The three install gates below re-state RLS's decisions as
    // API-shaped errors; see assertCanInstallTeamSkillFor.

    async listTeamSkills(teamId, opts: any = {}) {
      let subjectActorId = opts.actorId ?? null;
      if (!subjectActorId) {
        subjectActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      }
      let query = supabase.from("team_skills").select("*").eq("team_id", teamId);
      if (opts.status) query = query.eq("status", opts.status);
      if (opts.category) query = query.eq("category", opts.category);
      let { data, error } = await query.order("slug", { ascending: true });
      if (error) throw error;
      let rows = data ?? [];

      // Lazy marketplace align (§7.1).
      // A few at a time rather than one after another: each alignment is its
      // own two-to-five queries against a different skill, and a team that
      // subscribes to a dozen marketplace skills paid for them in series on
      // every poll.
      let alignedAny = false;
      const subscribed = rows.filter((r) => r.upstream_subscribed && r.origin === "marketplace");
      for (let i = 0; i < subscribed.length; i += MARKETPLACE_ALIGN_CONCURRENCY) {
        const moved = await Promise.all(
          subscribed
            .slice(i, i + MARKETPLACE_ALIGN_CONCURRENCY)
            .map((r) => this._alignMarketplaceSkillRow(r)),
        );
        if (moved.some(Boolean)) alignedAny = true;
      }
      // Re-read only when something moved, and keep the filters on the server.
      // This is the endpoint every daemon polls on a 10-minute tick: the old
      // unconditional refetch doubled its query count for teams with no
      // marketplace skills at all, and dropping .eq(status)/.eq(category)
      // pulled every skill row in the team over the wire to filter in JS.
      if (alignedAny) {
        let refetch = supabase.from("team_skills").select("*").eq("team_id", teamId);
        if (opts.status) refetch = refetch.eq("status", opts.status);
        if (opts.category) refetch = refetch.eq("category", opts.category);
        ({ data, error } = await refetch.order("slug", { ascending: true }));
        if (error) throw error;
        rows = data ?? [];
      }
      if (!rows.length) return [];

      const installs = subjectActorId
        ? await teamSkillInstallRows(supabase, subjectActorId, rows.map((r: any) => r.id))
        : new Map();
      return rows.map((r: any) => mapTeamSkillRow(r, installs.get(r.id)));
    },

    async getTeamSkill(teamId, slug, opts: any = {}) {
      let subjectActorId = opts.actorId ?? null;
      if (!subjectActorId) {
        subjectActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      }
      const { data, error } = await supabase
        .from("team_skills")
        .select("*")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "not_found", `skill not found: ${slug}`);

      const { data: versions, error: vErr } = await supabase
        .from("team_skill_versions")
        .select("*")
        .eq("skill_id", data.id)
        .order("version", { ascending: false });
      if (vErr) throw vErr;

      const installs = subjectActorId
        ? await teamSkillInstallRows(supabase, subjectActorId, [data.id])
        : new Map();
      return {
        ...mapTeamSkillRow(data, installs.get(data.id)),
        versions: (versions ?? []).map(mapTeamSkillVersionRow),
      };
    },

    async createTeamSkill(teamId, body: any = {}) {
      const fields = requireTeamSkillFields(body);
      // Lowercase here so `Deploy-Check` and `deploy-check` are one folder.
      // macOS volumes are case-insensitive; Linux is not.
      // NFC + ASCII lowercase. 整车成本智能表格 is stored unchanged.
      const slug = canonicalTeamSkillSlug(body.slug);
      assertTeamSkillSlug(slug);
      const displayName = teamSkillDisplayName(body.displayName, slug);
      const changelog = String(body.changelog ?? "").trim();
      if (!changelog) throw new ApiError(400, "validation_failed", "changelog is required");
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }

      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");

      const { data: blob, error: blobErr } = await supabase
        .from("amuxc_blobs")
        .select("verified, size")
        .eq("team_id", teamId)
        .eq("content_hash", contentHash)
        .maybeSingle();
      if (blobErr) throw blobErr;
      if (!blob?.verified) {
        throw new ApiError(
          422,
          "blob_unverified",
          "package blob must be uploaded and verified before publish",
        );
      }

      const { data, error } = await supabase
        .from("team_skills")
        .insert({
          team_id: teamId,
          slug,
          display_name: displayName,
          owner_actor_id: body.ownerActorId ?? callerActorId,
          summary: fields.summary,
          category: fields.category,
          when_to_use: fields.whenToUse ?? "",
          when_not_to_use: fields.whenNotToUse ?? "",
          requires: fields.requires ?? null,
          status: TEAM_SKILL_STATUSES.includes(body.status) ? body.status : "published",
          latest_version: 1,
          created_by: callerActorId,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          throw new ApiError(
            409,
            "conflict",
            `a skill named ${slug} already exists in this team`,
          );
        }
        throw error;
      }

      const { error: vErr } = await supabase.from("team_skill_versions").insert({
        skill_id: data.id,
        version: 1,
        content_hash: contentHash,
        size: Number(body.size ?? blob.size ?? 0),
        changelog,
        summary: fields.summary,
        category: fields.category,
        when_to_use: fields.whenToUse ?? "",
        when_not_to_use: fields.whenNotToUse ?? "",
        requires: fields.requires ?? null,
        created_by: callerActorId,
      });
      if (vErr) {
        // No transactions over PostgREST. Same compensating delete adopt uses:
        // a skill row without v1 is stuck, and the slug is taken so retry dies.
        const { error: cleanupErr } = await supabase.from("team_skills").delete().eq("id", data.id);
        if (cleanupErr) {
          console.error("[createTeamSkill] orphan team_skills row left behind:", data.id, cleanupErr);
        }
        throw vErr;
      }
      return mapTeamSkillRow(data);
    },

    async createTeamSkillVersion(teamId, slug, body: any = {}) {
      const changelog = String(body.changelog ?? "").trim();
      if (!changelog) throw new ApiError(400, "validation_failed", "changelog is required");
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }

      if (body.expectedLatestVersion === undefined || body.expectedLatestVersion === null) {
        throw new ApiError(400, "validation_failed", "expectedLatestVersion is required");
      }
      const expectedLatestVersion = Number(body.expectedLatestVersion);
      if (!Number.isInteger(expectedLatestVersion) || expectedLatestVersion < 0) {
        throw new ApiError(
          400,
          "validation_failed",
          "expectedLatestVersion must be a non-negative integer",
        );
      }

      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");

      const { data: blob, error: blobErr } = await supabase
        .from("amuxc_blobs")
        .select("verified, size")
        .eq("team_id", teamId)
        .eq("content_hash", contentHash)
        .maybeSingle();
      if (blobErr) throw blobErr;
      if (!blob?.verified) {
        throw new ApiError(
          422,
          "blob_unverified",
          "package blob must be uploaded and verified before publish",
        );
      }

      const patch = requireTeamSkillFields(body, { partial: true });

      const { data, error } = await supabase.rpc("publish_team_skill_version", {
        p_team_id: teamId,
        p_slug: slug,
        p_expected_latest_version: expectedLatestVersion,
        p_content_hash: contentHash,
        p_size: Number(body.size ?? blob.size ?? 0),
        p_changelog: changelog,
        p_summary: patch.summary ?? null,
        p_category: patch.category ?? null,
        p_when_to_use: patch.whenToUse !== undefined ? patch.whenToUse : null,
        p_when_not_to_use: patch.whenNotToUse !== undefined ? patch.whenNotToUse : null,
        p_requires: patch.requires !== undefined ? patch.requires : null,
      });

      if (error) {
        const msg = error.message ?? "publish failed";
        if (/stale_team_skill_base/i.test(msg)) {
          throw new ApiError(409, "stale_team_skill_base", msg);
        }
        if (error.code === "P0002" || /skill not found/i.test(msg)) {
          throw new ApiError(404, "not_found", msg);
        }
        if (error.code === "42501") {
          throw new ApiError(403, "forbidden", msg);
        }
        throw error;
      }

      return mapTeamSkillVersionRow(data);
    },

    /**
     * Re-publish an earlier version's content as the new latest.
     *
     * Rolling `latest_version` backwards would be the obvious alternative and
     * is deliberately not offered — it would leave members whose
     * `installed_version` exceeds `latest_version`, at which point "is there an
     * update" has no answer and the reconcile cannot tell whether to move them
     * forward or back. Versions only ever go up; a revert is a new one carrying
     * old content.
     */
    async revertTeamSkillVersion(teamId, slug, targetVersion: number, body: any = {}) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");

      const changelog = String(body.changelog ?? "").trim() || null;
      if (body.expectedLatestVersion === undefined || body.expectedLatestVersion === null) {
        throw new ApiError(400, "validation_failed", "expectedLatestVersion is required");
      }
      const expectedLatestVersion = Number(body.expectedLatestVersion);
      if (!Number.isInteger(expectedLatestVersion) || expectedLatestVersion < 0) {
        throw new ApiError(
          400,
          "validation_failed",
          "expectedLatestVersion must be a non-negative integer",
        );
      }

      const { data, error } = await supabase.rpc("revert_team_skill_version", {
        p_team_id: teamId,
        p_slug: slug,
        p_target_version: targetVersion,
        p_expected_latest_version: expectedLatestVersion,
        p_changelog: changelog,
      });

      if (error) {
        const msg = error.message ?? "revert failed";
        if (/already the latest/i.test(msg) || /stale_team_skill_base/i.test(msg)) {
          throw new ApiError(409, /stale_team_skill_base/i.test(msg) ? "stale_team_skill_base" : "conflict", msg);
        }
        if (error.code === "P0002" || /not found/i.test(msg)) {
          throw new ApiError(404, "not_found", msg);
        }
        if (error.code === "42501") {
          throw new ApiError(403, "forbidden", msg);
        }
        throw error;
      }

      return mapTeamSkillVersionRow(data);
    },

    async requireTeamAdmin(teamId) {
      const actor = await this.resolveCallerActorForTeam(teamId);
      if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");
      const { data, error } = await supabase.rpc("current_team_role", {
        target_team_id: teamId,
      });
      if (error) throw error;
      if (data !== "owner" && data !== "admin") {
        throw new ApiError(403, "forbidden", "team owner or admin access required");
      }
      return actor.id;
    },

    async updateTeamSkill(teamId, slug, patch: any = {}) {
      if (patch.status !== undefined || patch.supersededBy !== undefined) {
        await this.requireTeamAdmin(teamId);
      }
      const { data: existing, error: eErr } = await supabase
        .from("team_skills")
        .select("*")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (eErr) throw eErr;
      if (!existing) throw new ApiError(404, "not_found", `skill not found: ${slug}`);

      const snapshotKeys = ["summary", "category", "whenToUse", "whenNotToUse", "requires"];
      if (existing.upstream_subscribed && snapshotKeys.some((k) => patch[k] !== undefined)) {
        throw new ApiError(
          409,
          "subscribed",
          "disconnect from the marketplace before editing metadata",
        );
      }

      const fields = requireTeamSkillFields(patch, { partial: true });
      const update: any = {};
      if (fields.summary !== undefined) update.summary = fields.summary;
      if (fields.category !== undefined) update.category = fields.category;
      if (fields.whenToUse !== undefined) update.when_to_use = fields.whenToUse;
      if (fields.whenNotToUse !== undefined) update.when_not_to_use = fields.whenNotToUse;
      if (fields.requires !== undefined) update.requires = fields.requires;
      if (patch.ownerActorId !== undefined) update.owner_actor_id = patch.ownerActorId;
      if (patch.displayName !== undefined) {
        update.display_name = teamSkillDisplayName(patch.displayName, existing.slug);
      }
      if (patch.status !== undefined) {
        if (!TEAM_SKILL_STATUSES.includes(patch.status)) {
          throw new ApiError(400, "validation_failed", `unknown status: ${patch.status}`);
        }
        update.status = patch.status;
      }
      if (patch.supersededBy !== undefined) update.superseded_by = patch.supersededBy || null;

      if (!Object.keys(update).length) return this.getTeamSkill(teamId, slug);

      const { data, error } = await supabase
        .from("team_skills")
        .update(update)
        .eq("team_id", teamId)
        .eq("slug", slug)
        .select("*")
        .maybeSingle();
      if (error) {
        if (error.code === "42501") {
          throw new ApiError(403, "forbidden", "team owner or admin access required");
        }
        throw error;
      }
      if (!data) throw new ApiError(404, "not_found", `skill not found: ${slug}`);
      return mapTeamSkillRow(data);
    },

    async deleteTeamSkill(teamId, slug) {
      await this.requireTeamAdmin(teamId);
      const { error } = await supabase
        .from("team_skills")
        .delete()
        .eq("team_id", teamId)
        .eq("slug", slug);
      if (error) {
        if (error.code === "42501") {
          throw new ApiError(403, "forbidden", "team owner or admin access required");
        }
        throw error;
      }
    },

    async getTeamSkillVersion(teamId, slug, version) {
      const { data: skill, error } = await supabase
        .from("team_skills")
        .select("id, slug")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!skill) throw new ApiError(404, "not_found", `skill not found: ${slug}`);

      const { data, error: vErr } = await supabase
        .from("team_skill_versions")
        .select("*")
        .eq("skill_id", skill.id)
        .eq("version", version)
        .maybeSingle();
      if (vErr) throw vErr;
      if (!data) throw new ApiError(404, "not_found", `version ${version} not found`);
      return { ...mapTeamSkillVersionRow(data), slug: skill.slug, skillId: skill.id, teamId };
    },

    async getTeamSkillDownload(teamId, slug, version) {
      const { data: skill, error } = await supabase
        .from("team_skills")
        .select("id, slug")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!skill) throw new ApiError(404, "not_found", `skill not found: ${slug}`);

      const { data: ver, error: vErr } = await supabase
        .from("team_skill_versions")
        .select("*")
        .eq("skill_id", skill.id)
        .eq("version", version)
        .maybeSingle();
      if (vErr) throw vErr;
      if (!ver) throw new ApiError(404, "not_found", `version ${version} not found`);

      if (ver.blob_scope === "marketplace") {
        if (!ver.object_path) {
          throw new ApiError(
            409,
            "blob_missing",
            `marketplace package path missing for ${slug}@${version}`,
          );
        }
        return {
          contentHash: ver.content_hash,
          size: ver.size ?? 0,
          ossKey: ver.object_path,
        };
      }

      const { data, error: bErr } = await supabase
        .from("amuxc_blobs")
        .select("oss_key")
        .eq("team_id", teamId)
        .eq("content_hash", ver.content_hash)
        .maybeSingle();
      if (bErr) throw bErr;
      if (!data?.oss_key) {
        throw new ApiError(
          409,
          "blob_missing",
          `package blob for ${slug}@${version} is not uploaded yet`,
        );
      }
      return { contentHash: ver.content_hash, size: ver.size ?? 0, ossKey: data.oss_key };
    },

    async prepareTeamSkillBlob(teamId, body: any = {}) {
      const caller = await this.resolveCallerActorForTeam(teamId);
      if (!caller) throw new ApiError(403, "forbidden", "not a member of this team");
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }
      const size = Number(body.size ?? NaN);
      if (!Number.isFinite(size) || size < 0) {
        throw new ApiError(400, "validation_failed", "size must be a non-negative number");
      }
      const ossKey = `teams/${teamId}/blobs/sha256/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`;
      // amuxc_blobs predates the skills registry: it is the OSS-sync blob
      // ledger, where `authenticated` holds SELECT only and every write is
      // service_role's (20260527000002_oss_sync_schema.sql). Writing it with
      // the caller's token returns `42501 permission denied for table
      // amuxc_blobs`. Escalate rather than grant the client INSERT/UPDATE —
      // `verified` is the flag OSS sync trusts, and a member who can set it
      // by hand can point a team at a blob that was never uploaded.
      // Membership was checked above, and teamId comes from the route path.
      const admin = await serviceRoleClient("register a skill package blob");
      const { error } = await admin.from("amuxc_blobs").upsert(
        {
          team_id: teamId,
          content_hash: contentHash,
          oss_key: ossKey,
          size,
          verified: false,
        },
        { onConflict: "team_id,content_hash", ignoreDuplicates: true },
      );
      if (error) throw error;
      // Re-read so a previously verified blob is returned as verified:true.
      // ignoreDuplicates keeps that flag; without this SELECT the route treats
      // missing `verified` as needs-upload and content-addressed dedupe dies.
      const { data: row, error: rErr } = await admin
        .from("amuxc_blobs")
        .select("oss_key, size, verified")
        .eq("team_id", teamId)
        .eq("content_hash", contentHash)
        .maybeSingle();
      if (rErr) throw rErr;
      return {
        contentHash,
        size: row?.size ?? size,
        ossKey: row?.oss_key ?? ossKey,
        verified: !!row?.verified,
      };
    },

    async completeTeamSkillBlob(teamId, body: any = {}) {
      const caller = await this.resolveCallerActorForTeam(teamId);
      if (!caller) throw new ApiError(403, "forbidden", "not a member of this team");
      const contentHash = String(body.contentHash ?? "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new ApiError(400, "validation_failed", "contentHash must be a sha256 hex digest");
      }
      const { data, error } = await supabase
        .from("amuxc_blobs")
        .select("oss_key, size")
        .eq("team_id", teamId)
        .eq("content_hash", contentHash)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        throw new ApiError(404, "not_found", "blob placeholder not found — call prepare first");
      }
      // The lookup above stays on the caller's token so RLS keeps proving the
      // blob belongs to a team they are in; only the write escalates, for the
      // same reason as prepare.
      const admin = await serviceRoleClient("mark a skill package blob verified");
      const { error: uErr } = await admin
        .from("amuxc_blobs")
        .update({ verified: true })
        .eq("team_id", teamId)
        .eq("content_hash", contentHash);
      if (uErr) throw uErr;
      return { contentHash, size: data.size ?? 0, ossKey: data.oss_key };
    },

    /**
     * The three install gates. RLS already refuses the bad cases, but its
     * message is a raw Postgres string — this turns them into API-shaped
     * answers a client can act on.
     */
    async assertCanInstallTeamSkillFor(teamId, targetActorId) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
      if (targetActorId === callerActorId) return callerActorId;

      const { data: target, error } = await supabase
        .from("actors")
        .select("id, team_id")
        .eq("id", targetActorId)
        .maybeSingle();
      if (error) throw error;
      if (!target) throw new ApiError(404, "not_found", "target actor not found");
      if (target.team_id !== teamId) {
        throw new ApiError(403, "forbidden", "target actor belongs to a different team");
      }

      const { data: agentRow, error: agErr } = await supabase
        .from("agents")
        .select("visibility, owner_member_id")
        .eq("id", targetActorId)
        .maybeSingle();
      if (agErr) throw agErr;
      if (!agentRow) {
        throw new ApiError(
          403,
          "forbidden",
          "cannot install on behalf of another member — only on yourself or a team agent",
        );
      }
      // An agent you own is yours to install on, personal or not. A member's own
      // machine is an agent, not a member actor, and it is that actor the daemon
      // answers "what do I have installed" about — so sharing or publishing a
      // skill from the desktop has to be recordable against it. Without this the
      // record could only land on the member, where the machine's own inventory
      // never looks, and the skill went missing from the skills column while the
      // runtime went on loading it off disk.
      if (agentRow.owner_member_id && agentRow.owner_member_id === callerActorId) {
        return callerActorId;
      }
      if (agentRow.visibility !== "team") {
        throw new ApiError(
          403,
          "forbidden",
          "that agent is personal; only its owner can install skills on it",
        );
      }
      return callerActorId;
    },

    async installTeamSkill(teamId, slug, body: any = {}) {
      const { data: skill, error } = await supabase
        .from("team_skills")
        .select("id, latest_version")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!skill) throw new ApiError(404, "not_found", `skill not found: ${slug}`);

      let actorId = body.actorId ?? null;
      if (!actorId) actorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!actorId) throw new ApiError(403, "forbidden", "not a member of this team");
      await this.assertCanInstallTeamSkillFor(teamId, actorId);

      const scope = body.scope === "workspace" ? "workspace" : "global";
      const workspaceId = scope === "workspace" ? (body.workspaceId ?? null) : null;
      if (scope === "workspace" && !workspaceId) {
        throw new ApiError(400, "validation_failed", "workspaceId is required for workspace scope");
      }
      const version = Number(body.version ?? skill.latest_version);
      if (!Number.isInteger(version) || version < 1 || version > skill.latest_version) {
        throw new ApiError(400, "validation_failed", `unknown version: ${body.version}`);
      }

      // No onConflict target here: the unique index coalesces workspace_id, and
      // PostgREST cannot name an expression index. Delete-then-insert keeps the
      // upsert semantics without depending on the index name.
      const { error: dErr } = await supabase
        .from("team_skill_installs")
        .delete()
        .eq("actor_id", actorId)
        .eq("skill_id", skill.id)
        .eq("scope", scope);
      if (dErr) throw dErr;

      const { data, error: iErr } = await supabase
        .from("team_skill_installs")
        .insert({
          team_id: teamId,
          actor_id: actorId,
          skill_id: skill.id,
          installed_version: version,
          scope,
          workspace_id: workspaceId,
        })
        .select("*")
        .single();
      if (iErr) throw iErr;
      return mapTeamSkillInstallRow(data);
    },

    async uninstallTeamSkill(teamId, slug, body: any = {}) {
      const { data: skill, error } = await supabase
        .from("team_skills")
        .select("id")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!skill) throw new ApiError(404, "not_found", `skill not found: ${slug}`);

      let actorId = body.actorId ?? null;
      if (!actorId) actorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!actorId) throw new ApiError(403, "forbidden", "not a member of this team");
      await this.assertCanInstallTeamSkillFor(teamId, actorId);

      const { error: dErr } = await supabase
        .from("team_skill_installs")
        .delete()
        .eq("actor_id", actorId)
        .eq("skill_id", skill.id);
      if (dErr) throw dErr;
    },

    async listTeamSkillInstalls(teamId, opts: any = {}) {
      let actorId = opts.actorId ?? null;
      if (!actorId) actorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!actorId) throw new ApiError(403, "forbidden", "not a member of this team");

      const { data, error } = await supabase
        .from("team_skill_installs")
        .select("*, team_skills!inner(slug, latest_version, status)")
        .eq("team_id", teamId)
        .eq("actor_id", actorId);
      if (error) throw error;
      return (data ?? [])
        .map((r: any) => ({
          ...mapTeamSkillInstallRow(r),
          slug: r.team_skills?.slug ?? null,
          latestVersion: r.team_skills?.latest_version ?? 0,
          status: r.team_skills?.status ?? null,
          hasUpdate: (r.installed_version ?? 0) < (r.team_skills?.latest_version ?? 0),
        }))
        .sort((a: any, b: any) => String(a.slug).localeCompare(String(b.slug)));
    },

    ...makeSupabaseMarketplaceMethods({
      supabase,
      serviceRoleClient,
      mapTeamSkillRow,
      resolveCallerActorForTeam: callerActorForTeam,
    }),

    // ─── Knowledge path ACL ──────────────────────────────────────────────────
    // docs/specs/2026-08-31-knowledge-path-acl-design.md
    //
    // Unlike team MCP above, authz here CANNOT live in RLS: the ACL tables carry
    // RLS with no policy, because `path_prefix` is a directory name and any
    // "members may read the rules" policy would hand out exactly the list the
    // feature exists to withhold. The module checks owner/admin itself and then
    // uses the service role, the same shape /sync/* already has.
    ...makeKnowledgeAclRepo({
      supabase,
      serviceRoleClient,
      resolveCallerActorForTeam: callerActorForTeam,
    }),

    // Document libraries share the knowledge-ACL host: owner/admin, then service role.
    ...makeDocumentLibrariesRepo({
      supabase,
      serviceRoleClient,
      resolveCallerActorForTeam: callerActorForTeam,
    }),

    // ─── Cross-device Wiki maintainer checkpoints ───────────────────────────
    ...makeWikiMaintainerRepo({
      supabase,
      serviceRoleClient,
      resolveCallerActorForTeam: callerActorForTeam,
    }),

    // ─── Org roles catalog ───────────────────────────────────────────────────
    // docs/specs/2026-09-15-org-roles-permissions-design.md
    // Authz: current_team_role (owner/admin) + system immutable + binding 409.
    ...makeOrgRolesRepo({
      supabase,
      serviceRoleClient,
      resolveCallerActorForTeam: callerActorForTeam,
    }),

    // ─── Team MCP catalog ────────────────────────────────────────────────────
    // docs/architecture/team-mcp-and-env-cloud.md
    //
    // Authz lives in RLS here (20260806020000_team_mcp_and_env.sql), so these
    // are thin. The *validation* is not authz and must not be left to RLS: the
    // secret-literal gate and the transport invariants live in
    // lib/validation/team-mcp.ts and are imported rather than restated, because
    // two copies of a security rule is exactly how one of them ends up weaker.

    // `actorId` defaults to the caller; passing another actor's id reads their
    // install state, which is how a client shows what a given agent has
    // installed. Reading is deliberately not symmetric with writing:
    // install/uninstall still refuse `actorId`, because you cannot install on
    // anyone else's behalf. Membership in the team is the only gate — an actor
    // id from outside the team simply matches no installs.
    async listTeamMcpServers(teamId, opts: { actorId?: string } = {}) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      const subjectActorId = opts.actorId ?? callerActorId;
      const { data, error } = await supabase
        .from("team_mcp_servers")
        .select("*")
        .eq("team_id", teamId)
        .order("name", { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      if (!rows.length) return [];

      let installedIds = new Set<string>();
      if (subjectActorId) {
        const { data: installs, error: iErr } = await supabase
          .from("team_mcp_installs")
          .select("server_id")
          .eq("actor_id", subjectActorId);
        if (iErr) throw iErr;
        installedIds = new Set((installs ?? []).map((i: any) => i.server_id));
      }
      return rows.map((r: any) => mapTeamMcpServerRow(r, installedIds.has(r.id)));
    },

    async getTeamMcpConfig(teamId) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!callerActorId) return { mcpServers: {} };
      const { data, error } = await supabase
        .from("team_mcp_installs")
        .select("team_mcp_servers!inner(name, transport, command, args, url, headers, env)")
        .eq("team_id", teamId)
        .eq("actor_id", callerActorId);
      if (error) throw error;
      const mcpServers: Record<string, any> = {};
      for (const row of data ?? []) {
        const s = (row as any).team_mcp_servers;
        if (!s) continue;
        const entry: Record<string, unknown> = {};
        if (s.transport === "remote") {
          entry.url = s.url;
          if (s.headers) entry.headers = s.headers;
        } else {
          entry.command = s.command;
          if (s.args) entry.args = s.args;
        }
        if (s.env) entry.env = s.env;
        mcpServers[s.name] = entry;
      }
      return { mcpServers };
    },

    async createTeamMcpServer(teamId, body: any = {}) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
      const name = String(body.name ?? "").trim();
      if (!TEAM_MCP_NAME_RE.test(name)) {
        throw new ApiError(
          400,
          "validation_failed",
          "name must be 1-64 chars of [A-Za-z0-9_.-] and start with a letter or digit",
        );
      }
      const fields = readTeamMcpServerFields(body);
      assertTeamMcpTransportShape({
        transport: fields.transport as string,
        command: fields.command,
        url: fields.url,
      });

      const { data, error } = await supabase
        .from("team_mcp_servers")
        .insert({
          team_id: teamId,
          name,
          transport: fields.transport,
          command: fields.command ?? null,
          args: fields.args ?? null,
          url: fields.url ?? null,
          headers: fields.headers ?? null,
          env: fields.env ?? null,
          description: fields.description ?? null,
          created_by: callerActorId,
          updated_by: callerActorId,
        })
        .select()
        .single();
      if (error) {
        if ((error as any).code === "23505") {
          throw new ApiError(409, "conflict", `an mcp server named ${name} already exists`);
        }
        throw error;
      }
      return mapTeamMcpServerRow(data, false);
    },

    async updateTeamMcpServer(teamId, name, patch: any = {}) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
      const { data: existing, error: exErr } = await supabase
        .from("team_mcp_servers")
        .select("*")
        .eq("team_id", teamId)
        .eq("name", name)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!existing) throw new ApiError(404, "not_found", `mcp server not found: ${name}`);

      const fields = readTeamMcpServerFields(patch, { partial: true });
      if (!Object.keys(fields).length) return mapTeamMcpServerRow(existing, false);
      assertTeamMcpTransportShape({
        transport: (fields.transport as string) ?? existing.transport,
        command: fields.command !== undefined ? fields.command : existing.command,
        url: fields.url !== undefined ? fields.url : existing.url,
      });

      const update: Record<string, unknown> = { updated_by: callerActorId };
      if (fields.transport !== undefined) update.transport = fields.transport;
      if (fields.command !== undefined) update.command = fields.command;
      if (fields.args !== undefined) update.args = fields.args;
      if (fields.url !== undefined) update.url = fields.url;
      if (fields.headers !== undefined) update.headers = fields.headers;
      if (fields.env !== undefined) update.env = fields.env;
      if (fields.description !== undefined) update.description = fields.description;

      const { data, error } = await supabase
        .from("team_mcp_servers")
        .update(update)
        .eq("id", existing.id)
        .select()
        .maybeSingle();
      if (error) throw error;
      // RLS filters the row out rather than erroring when the caller is neither
      // creator nor admin, so an empty result is a permission answer.
      if (!data) {
        throw new ApiError(403, "forbidden", "only the server's creator or a team admin may do this");
      }
      return mapTeamMcpServerRow(data, false);
    },

    async deleteTeamMcpServer(teamId, name) {
      const { data: existing, error: exErr } = await supabase
        .from("team_mcp_servers")
        .select("id")
        .eq("team_id", teamId)
        .eq("name", name)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!existing) throw new ApiError(404, "not_found", `mcp server not found: ${name}`);
      const { data, error } = await supabase
        .from("team_mcp_servers")
        .delete()
        .eq("id", existing.id)
        .select("id");
      if (error) throw error;
      if (!data?.length) {
        throw new ApiError(403, "forbidden", "only the server's creator or a team admin may do this");
      }
    },

    async installTeamMcpServer(teamId, name) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
      const { data: server, error: sErr } = await supabase
        .from("team_mcp_servers")
        .select("id, name")
        .eq("team_id", teamId)
        .eq("name", name)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!server) throw new ApiError(404, "not_found", `mcp server not found: ${name}`);

      const { data, error } = await supabase
        .from("team_mcp_installs")
        .upsert(
          { team_id: teamId, actor_id: callerActorId, server_id: server.id },
          { onConflict: "actor_id,server_id" },
        )
        .select()
        .single();
      if (error) throw error;
      return {
        id: data.id,
        teamId: data.team_id,
        actorId: data.actor_id,
        serverId: data.server_id,
        name: server.name,
        installedAt: data.installed_at ?? null,
        updatedAt: data.updated_at ?? null,
      };
    },

    async uninstallTeamMcpServer(teamId, name) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
      const { data: server, error: sErr } = await supabase
        .from("team_mcp_servers")
        .select("id")
        .eq("team_id", teamId)
        .eq("name", name)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!server) throw new ApiError(404, "not_found", `mcp server not found: ${name}`);
      const { error } = await supabase
        .from("team_mcp_installs")
        .delete()
        .eq("actor_id", callerActorId)
        .eq("server_id", server.id);
      if (error) throw error;
    },

    // ─── Team env secrets ────────────────────────────────────────────────────
    // Ciphertext in, ciphertext out. Nothing here can decrypt, by design.

    async listTeamEnvSecrets(teamId) {
      const { data, error } = await supabase
        .from("team_env_secrets")
        .select("*")
        .eq("team_id", teamId)
        .order("key_id", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapTeamEnvSecretRow);
    },

    async putTeamEnvSecret(teamId, keyId, body: any = {}) {
      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id ?? null;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
      assertWritableTeamEnvKeyId(keyId);
      const envelope = readTeamEnvEnvelope(body);

      const { data: existing, error: exErr } = await supabase
        .from("team_env_secrets")
        .select("id")
        .eq("team_id", teamId)
        .eq("key_id", keyId)
        .maybeSingle();
      if (exErr) throw exErr;

      // Split insert/update rather than upsert so `created_by` is never
      // reassigned: it is the delete gate, and handing it to the most recent
      // writer would quietly transfer deletion rights.
      if (existing) {
        const { data, error } = await supabase
          .from("team_env_secrets")
          .update({ envelope, updated_by: callerActorId })
          .eq("id", existing.id)
          .select()
          .single();
        if (error) throw error;
        return mapTeamEnvSecretRow(data);
      }
      const { data, error } = await supabase
        .from("team_env_secrets")
        .insert({
          team_id: teamId,
          key_id: keyId,
          envelope,
          created_by: callerActorId,
          updated_by: callerActorId,
        })
        .select()
        .single();
      if (error) throw error;
      return mapTeamEnvSecretRow(data);
    },

    async deleteTeamEnvSecret(teamId, keyId) {
      const { data, error } = await supabase
        .from("team_env_secrets")
        .delete()
        .eq("team_id", teamId)
        .eq("key_id", keyId)
        .select("id");
      if (error) throw error;
      if (!data?.length) {
        // Either it never existed or RLS refused — the caller cannot tell those
        // apart, and neither can we without a second privileged read.
        throw new ApiError(
          404,
          "not_found",
          `env secret not found, or you are not its creator: ${keyId}`,
        );
      }
    },
  };
}

// ─── Team MCP / env helpers ──────────────────────────────────────────────────
//
// Validation is imported from lib/validation/ rather than restated here: these
// are security rules (what may hold a literal secret) and correctness rules
// (which transport needs which fields), and a second copy is how the route
// layer and the repository drift into disagreeing about what is allowed.

function mapTeamMcpServerRow(row: any, installed: boolean) {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? null,
    args: row.args ?? null,
    url: row.url ?? null,
    headers: row.headers ?? null,
    env: row.env ?? null,
    description: row.description ?? null,
    installed,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function mapTeamEnvSecretRow(row: any) {
  return {
    keyId: row.key_id,
    envelope: row.envelope,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

// ─── Team skills helpers ─────────────────────────────────────────────────────

// How many marketplace-subscribed skills `listTeamSkills` aligns at once.
const MARKETPLACE_ALIGN_CONCURRENCY = 4;

const TEAM_SKILL_CATEGORIES = [
  "general", "coding", "devops", "data",
  "research", "writing", "communication", "integration",
];

const TEAM_SKILL_STATUSES = ["draft", "published", "deprecated"];

/**
 * The publish gate: every one of these is required because the registry exists
 * to stop "who owns this / when to use it / when NOT to use it" from living in
 * one free-text description blob.
 */
function requireTeamSkillFields(body: any, { partial = false } = {}): any {
  const out: any = {};
  const need = (key: string, value: unknown, label: string) => {
    if (value === undefined) {
      if (partial) return;
      throw new ApiError(400, "validation_failed", `${label} is required`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "validation_failed", `${label} must be a non-empty string`);
    }
    out[key] = value.trim();
  };
  // Present-but-empty is a real answer here, and it is stored as one.
  // Omitted on a full publish (not a patch) defaults to "" so the NOT NULL
  // columns without a DB default do not 23502. Matches marketplace tables.
  const optional = (key: string, value: unknown) => {
    if (value === undefined) {
      if (!partial) out[key] = "";
      return;
    }
    out[key] = typeof value === "string" ? value.trim() : "";
  };
  // `summary` and `category` stay required: one is the list subtitle, the other
  // drives filtering, and a registry full of blanks in either is unusable.
  // The two guidance fields are not — they are what a thoughtful author writes,
  // not a gate on sharing at all. Demanding them up front mostly produced
  // placeholder text, which is worse than an empty field: it reads as guidance
  // and isn't.
  need("summary", body.summary, "summary");
  need("category", body.category, "category");
  optional("whenToUse", body.whenToUse);
  optional("whenNotToUse", body.whenNotToUse);

  if (out.summary !== undefined && out.summary.length > 200) {
    throw new ApiError(400, "validation_failed", "summary must be 200 characters or fewer");
  }
  if (out.category !== undefined && !TEAM_SKILL_CATEGORIES.includes(out.category)) {
    throw new ApiError(
      400,
      "validation_failed",
      `category must be one of: ${TEAM_SKILL_CATEGORIES.join(", ")}`,
    );
  }
  if (body.requires !== undefined) out.requires = body.requires ?? null;
  return out;
}

async function teamSkillInstallRows(supabase, actorId: string, skillIds: string[]) {
  const { data, error } = await supabase
    .from("team_skill_installs")
    .select("*")
    .eq("actor_id", actorId)
    .in("skill_id", skillIds);
  if (error) throw error;
  const map = new Map<string, any>();
  for (const row of data ?? []) map.set(row.skill_id, row);
  return map;
}

function mapTeamSkillRow(r: any, install?: any) {
  return {
    id: r.id,
    teamId: r.team_id,
    slug: r.slug,
    displayName:
      typeof r.display_name === "string" && r.display_name.trim()
        ? r.display_name.trim()
        : r.slug,
    ownerActorId: r.owner_actor_id,
    summary: r.summary,
    category: r.category,
    whenToUse: r.when_to_use,
    whenNotToUse: r.when_not_to_use,
    requires: r.requires ?? null,
    status: r.status,
    supersededBy: r.superseded_by ?? null,
    latestVersion: r.latest_version ?? 0,
    createdBy: r.created_by,
    origin: r.origin ?? "local",
    upstreamSlug: r.upstream_slug ?? null,
    upstreamSubscribed: !!r.upstream_subscribed,
    upstreamDetachedAt: appIso(r.upstream_detached_at),
    createdAt: appIso(r.created_at),
    updatedAt: appIso(r.updated_at),
    installed: !!install,
    installedVersion: install?.installed_version ?? null,
    installScope: install?.scope ?? null,
    hasUpdate: !!install && install.installed_version < (r.latest_version ?? 0),
  };
}

function mapTeamSkillVersionRow(r: any) {
  return {
    version: r.version,
    contentHash: r.content_hash,
    size: r.size ?? 0,
    changelog: r.changelog,
    summary: r.summary,
    category: r.category ?? null,
    whenToUse: r.when_to_use,
    whenNotToUse: r.when_not_to_use,
    requires: r.requires ?? null,
    createdBy: r.created_by,
    publishedFromVersion: r.published_from_version ?? null,
    createdAt: appIso(r.created_at),
  };
}

function mapTeamSkillInstallRow(r: any) {
  return {
    id: r.id,
    teamId: r.team_id,
    actorId: r.actor_id,
    skillId: r.skill_id,
    installedVersion: r.installed_version,
    scope: r.scope,
    workspaceId: r.workspace_id ?? null,
    installedAt: appIso(r.installed_at),
    updatedAt: appIso(r.updated_at),
  };
}
