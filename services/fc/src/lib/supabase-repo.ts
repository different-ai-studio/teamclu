/**
 * Path A business repository — PostgREST + caller JWT + RLS (default production).
 *
 * Parity target: lib/pg-repo/* (Path B). New methods belong here AND in pg-repo
 * unless explicitly supabase-only. See README.md § Dual backend paths.
 */
import { randomUUID } from "node:crypto";
import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import { verifyTrustedExternalJwt } from "./trusted-external-jwt.js";
import { aiGateway } from "./ai-gateway.js";
import { createCheckoutSession, listCreditPackages } from "./stripe.js";
import { ApiError } from "./http-utils.js";
import { DEFAULT_LIST_LIMIT, DEFAULT_MESSAGE_LIST_LIMIT } from "./routing-utils.js";

import { resolveFeatures } from "./routes/config.js";

/**
 * Self-registration switch, resolved per request from the deployment's feature
 * profile. Unset means allowed — every deployment behaves as it does today
 * until someone turns it off. See FeatureFlags.allowNewOrg for why this gates
 * "mint an org" rather than "create a team", and why it is FC-only.
 */
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

import { makeSupabaseMarketplaceMethods } from "./supabase-repo/marketplace.js";
import { makeKnowledgeAclRepo } from "./supabase-repo/knowledge-acl.js";
import { isLegalStatusTransition } from "./pg-repo/app-status.js";
// Shared with the pg-repo twin on purpose — validation only; keep free of
// PostgREST/Drizzle calls so both backends can import these helpers.
import {
  assertTransportShape as assertTeamMcpTransportShape,
  readServerFields as readTeamMcpServerFields,
  NAME_RE as TEAM_MCP_NAME_RE,
} from "./pg-repo/team-mcp.js";
import {
  assertWritableKeyId as assertWritableTeamEnvKeyId,
  readEnvelope as readTeamEnvEnvelope,
} from "./pg-repo/team-env-secrets.js";
import { isLegalFcTransition } from "./provisioning/app-fc-status.js";
import { appOssObjectName, deployUnavailable, parseOptionalGitCommitSha, parseDeployToken, assertDeployAllowed, checkDeployInProgress, needsDatabase } from "./provisioning/app-deploy.js";
import { decodeRowKey, describeDbError, parsePageLimit, type AppDataTarget, type FilterOp } from "./provisioning/app-data-db.js";
import { teardownAppResources, type TeardownAppDeps } from "./provisioning/app-delete.js";
import { giteaUnavailable, GITEA_AUTH_KIND } from "./provisioning/gitea.js";
import { issueJitDeployKey, revokeActorDeployKeys } from "./provisioning/deploy-key.js";
import {
  applyAuthModeChange,
  buildPlatformOAuthEnv,
  parseAuthMode,
  type AuthMode,
} from "./provisioning/app-auth-mode.js";
import {
  deleteAppSecretSupabase,
  getAppSecretSupabase,
  putAppSecretSupabase,
} from "./provisioning/app-secrets.js";
import { normalizeAgentTypes } from "./agent-types.js";
import { isListableAgentStatus, LISTABLE_AGENT_STATUS_OR_FILTER } from "./agent-status.js";
import { computeRange, getLiteLlmSql, queryTeamUsage } from "./litellm-usage.js";
import { rollUpUsageByOwner, type UsageOwner } from "./usage-attribution.js";
import { litellmFetch as sharedLitellmFetch } from "./litellm.js";
import {
  REALTIME_TRANSPORT_OPTS, requiredRow, requiredString, requiredInteger,
  DEFAULT_ATTACHMENT_BUCKET, TEAM_COLUMNS, MESSAGE_COLUMNS, WORKSPACE_COLUMNS, mapDefaultAgentError,
  APP_COLUMNS, slugify, appIso, mapApp, SESSION_FULL_COLUMNS, ACTOR_DIRECTORY_COLUMNS,
  mapSessionFull, mapDirectoryActor, publishableKeyFromEnv, outgoingMessageRow,
  mapTeam, mapSession, mapMessage, mapWorkspace, mapShortcut, mapTeamRole, mapPermission,
  mapActor, mapTeamMember, mapIdeaRow, mapShortcutRow, mapIdeaActivityRow,
  mapFeedbackRow, mapLeaderboardRow, chunkedIn,
} from "./supabase-repo/shared.js";
export { publishableKeyFromEnv } from "./supabase-repo/shared.js";
export { createSupabaseAuthRepository } from "./supabase-repo/auth.js";
import { normalizePhone } from "./supabase-repo/phone-auth.js";

/**
 * `actors.id` is a uuid column: a non-uuid in the `.in()` list makes PostgREST
 * reject the whole request (22P02), which would take the usage screen down over
 * one malformed LiteLLM user_id. Unmatched ids just report as "unattributed".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map spending actor ids → the accountable human (supabase/PostgREST twin of
 * pg-repo's resolveOwnersForTeam; kept behaviourally identical).
 *
 * Three flat queries rather than one embedded select: PostgREST resource
 * embedding would need the actors→agents FK relationship spelled by name, and
 * a rename there fails at runtime, not build time.
 *
 * Team-scoped on purpose — ids come from LiteLLM, so an unscoped lookup would
 * let any key surface an unrelated team's member name.
 */
async function resolveOwnersForTeam(supabase, teamId, actorIds): Promise<Map<string, UsageOwner>> {
  const ids = actorIds.filter((id) => UUID_RE.test(id));
  const out = new Map<string, UsageOwner>();
  if (!ids.length) return out;

  const actorRows = await chunkedIn(ids, async (chunk) => {
    const { data, error } = await supabase
      .from("actors")
      .select("id, actor_type, display_name")
      .eq("team_id", teamId)
      .in("id", chunk);
    if (error) throw error;
    return data ?? [];
  });
  if (!actorRows.length) return out;

  const agentIds = actorRows.filter((a) => a.actor_type === "agent").map((a) => a.id);
  const ownerOf = new Map<string, string>();
  if (agentIds.length) {
    const agentRows = await chunkedIn(agentIds, async (chunk) => {
      const { data, error } = await supabase
        .from("agents")
        .select("id, owner_member_id")
        .in("id", chunk);
      if (error) throw error;
      return data ?? [];
    });
    for (const r of agentRows) if (r.owner_member_id) ownerOf.set(r.id, r.owner_member_id);
  }

  // Owner display names: an agent's owner need not be among the spending actors
  // (a human can own a daemon and never spend under their own key), so their
  // actor row may not be in actorRows and has to be fetched separately.
  const nameOf = new Map<string, string>(actorRows.map((a) => [a.id, a.display_name]));
  const missing = [...new Set([...ownerOf.values()])].filter((id) => !nameOf.has(id));
  if (missing.length) {
    const ownerRows = await chunkedIn(missing, async (chunk) => {
      const { data, error } = await supabase
        .from("actors")
        .select("id, display_name")
        .eq("team_id", teamId)
        .in("id", chunk);
      if (error) throw error;
      return data ?? [];
    });
    for (const r of ownerRows) nameOf.set(r.id, r.display_name);
  }

  for (const a of actorRows) {
    if (a.actor_type === "agent") {
      const ownerId = ownerOf.get(a.id);
      const ownerName = ownerId ? nameOf.get(ownerId) : undefined;
      if (ownerId && ownerName) out.set(a.id, { actorId: ownerId, displayName: ownerName });
      continue;
    }
    out.set(a.id, { actorId: a.id, displayName: a.display_name });
  }
  return out;
}

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
  const trimmed = path.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "") || trimmed;
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

async function archiveSessionsForWorkspace(supabase, workspaceId) {
  const { data: participants, error: rtError } = await supabase
    .from("session_participants")
    .select("session_id")
    .eq("workspace_id", workspaceId);
  if (rtError) throw rtError;

  const sessionIds = [...new Set(
    (participants ?? [])
      .map((row) => row.session_id)
      .filter((id) => typeof id === "string" && id.length > 0),
  )];
  if (sessionIds.length === 0) return;

  const archivedAt = new Date().toISOString();
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

const APP_PERMISSION_LEVELS = new Set(["view", "prompt", "admin"]);

function parseAppPermissionLevel(raw: string): string {
  if (!APP_PERMISSION_LEVELS.has(raw)) {
    throw new ApiError(400, "validation_failed", "permissionLevel must be view, prompt, or admin");
  }
  return raw;
}

function mapAppAccessRow(r: any) {
  return {
    memberId: r.member_id,
    permissionLevel: r.permission_level,
    grantedByMemberId: r.granted_by_member_id ?? null,
    createdAt: appIso(r.created_at)!,
  };
}

/**
 * Turn a driver error into an ApiError without letting the query or the row
 * values escape.
 *
 * Postgres error objects carry `query`, `parameters`, and frequently a fragment
 * of the offending value in `detail`. Rethrowing one as-is puts the user's
 * business data into an HTTP body and, worse, into whatever logs the error.
 */
async function runAppData<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    const { sqlstate } = describeDbError(e);
    if (sqlstate === "57014") {
      throw new ApiError(504, "query_timeout", "the query took too long and was cancelled");
    }
    // 22P02 invalid_text_representation: the filter value cannot be coerced to
    // the column's type ("abc" against an integer column). That is the caller's
    // input being wrong, not the database failing.
    if (sqlstate === "22P02" || sqlstate === "22007") {
      throw new ApiError(400, "invalid_filter_value", "the filter value does not match the column's type");
    }
    console.warn(`[apps] app data query failed (sqlstate ${sqlstate ?? "unknown"})`);
    throw new ApiError(502, "app_data_query_failed", `the app database rejected the query${sqlstate ? ` (${sqlstate})` : ""}`);
  }
}

const APP_DATA_FILTER_OPS: readonly FilterOp[] = ["eq", "contains", "isNull", "notNull"];

/** `filterColumn` + `filterOp` (+ `filterValue`), or nothing. */
function parseAppDataFilter(query: any): { column: string; op: FilterOp; value?: unknown } | null {
  const column = query?.filterColumn;
  if (typeof column !== "string" || !column) return null;
  const op = query?.filterOp;
  if (!APP_DATA_FILTER_OPS.includes(op)) {
    throw new ApiError(400, "validation_failed", `filterOp must be one of ${APP_DATA_FILTER_OPS.join(", ")}`);
  }
  return { column, op, value: query?.filterValue };
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
    provisionLiteLlm,
    // Injectable for tests; defaults to proxying the LiteLLM gateway /v1/models.
    fetchLiteLlmModels: fetchLiteLlmModelsOpt,
    startDeploy,
    finalizeDeploy,
    // Set when the two above are absent: names the environment variable that
    // made deploy provisioning unavailable (see makeDeployDeps in index.ts).
    deployUnavailableReason,
    gitea,
    giteaUnavailableReason,
    gotrue,
    gotrueUnavailableReason,
    teardownDeps,
    // The app-data browser's four operations, with the admin connection bound
    // (see makeAppDataOps). Absent when APPS_DB_ADMIN_URL is unset — the
    // reason names the variable so the 503 is actionable.
    appData,
    appDataUnavailableReason,
    // Injectable for tests; defaults to querying the LiteLLM RDS directly.
    queryLiteLlmUsage = (litellmTeamId, range) => queryTeamUsage(getLiteLlmSql(), litellmTeamId, range),
    // Injectable for tests; defaults to the shared LiteLLM HTTP client.
    litellmFetch: litellmFetchOpt,
    trustedExternalJwtSecret = process.env.TRUSTED_EXTERNAL_JWT_SECRET,
    // Optional push hook — called after every successful message INSERT. Best-effort:
    // errors are logged and swallowed so insert outcome is never affected.
    dispatchPush,
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
  async function getCurrentUser() {
    if (!trustedExternalJwtSecret) return supabase.auth.getUser();
    try {
      const user = await verifyTrustedExternalJwt(accessToken, trustedExternalJwtSecret);
      return { data: { user }, error: null };
    } catch (cause) {
      return { data: { user: null }, error: cause };
    }
  }

  async function requireCallerTeamOwner(targetTeamId) {
    const { data: authData, error: authErr } = await supabase.auth.getUser();
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

    const { data: membership, error: memberErr } = await supabase
      .from("team_members")
      .select("role")
      .eq("team_id", targetTeamId)
      .eq("member_id", actor.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!membership || membership.role !== "owner") {
      throw new ApiError(403, "forbidden", "only team owners may change team share mode");
    }
  }

  async function requireCallerTeamMember(targetTeamId) {
    const { data: authData, error: authErr } = await supabase.auth.getUser();
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
    const { data: authData, error: authErr } = await supabase.auth.getUser();
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

  // Shared by setupLiteLlm() and ensureMemberKey(): provisions a LiteLLM team
  // (if not already configured) and persists litellm_team_id +
  // ai_gateway_endpoint via the update_team_litellm RPC. Returns the FULL
  // provisioning result (including the LiteLLM-generated litellmTeamId) so
  // callers never need to reconstruct/guess the id — provisionTeamLiteLLM
  // persists whatever team_id LiteLLM's own POST /team/new assigns, NOT a
  // deterministic `tc-${teamId}` value, so any code that assumed the latter
  // would silently talk to the wrong (or a non-existent) LiteLLM team.
  async function provisionLiteLlmForTeam(teamId) {
    const provisioner = provisionLiteLlm ?? (await import("./team-provisioning.js")).provisionTeamLiteLLM;
    const { data: teamRow, error: teamErr } = await supabase
      .from("teams")
      .select("id, name")
      .eq("id", teamId)
      .single();
    if (teamErr) throw teamErr;
    const provisioning = await provisioner(teamRow?.name ?? teamId);
    if (!provisioning) {
      throw new ApiError(
        503,
        "litellm_unavailable",
        "LiteLLM provisioning is not configured (LITELLM_MASTER_KEY missing)",
      );
    }
    const { error: rpcErr } = await supabase.rpc("update_team_litellm", {
      p_team_id: teamId,
      p_litellm_team_id: provisioning.litellmTeamId,
      p_ai_gateway_endpoint: provisioning.aiGatewayEndpoint,
    });
    if (rpcErr) throw rpcErr;
    return provisioning;
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

  /**
   * Revoke JIT deploy keys when access is removed or downgraded to view-only.
   *
   * Best-effort throughout, like the `revokeActorDeployKeys` it wraps. This
   * runs *after* the grant row is already gone, so throwing here reported a
   * completed revoke as a 500 — the caller then retries against a grant that
   * no longer exists. A deployment with no service-role key, or a transient
   * PostgREST error, must not turn "access removed" into "request failed".
   * The keys that survive are still bounded by the expiry sweep.
   */
  async function revokeAppMemberDeployKeysIfGitea(appId: string, memberId: string): Promise<void> {
    if (!gitea) return;
    try {
      const admin = await serviceRoleClient("revoke deploy keys on deauth");
      const { data: app, error } = await admin
        .from("apps")
        .select("id, git_auth_kind")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app || app.git_auth_kind !== GITEA_AUTH_KIND) return;
      await revokeActorDeployKeys(gitea, appId, memberId);
    } catch (e) {
      console.warn("[apps] deploy key revoke failed after deauth (non-fatal)", e);
    }
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
      // caller may join. `p_default_org_id` survives only in the RPC signature
      // — the function body has never read it, and FC no longer supplies it.
      const { data, error } = await supabase.rpc("list_teams_for_picker", {
        p_default_org_id: null,
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

    async listDiscoverableTeams() {
      const { data, error } = await supabase.rpc("list_discoverable_teams");
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.team_id,
        name: r.team_name,
        slug: r.team_slug ?? null,
        orgId: r.org_id ?? null,
        orgName: r.org_name ?? null,
        visibility: r.visibility ?? "public",
        isMember: r.is_member === true,
      }));
    },

    // Self-service join of a PUBLIC team. Invoked when
    // the user picks a public team they are not yet a member of. The RPC adds a
    // plain 'member' actor (idempotent if already joined) and rejects anything
    // that is not public.
    async joinPublicTeam(teamId) {
      // `p_default_org_id` is vestigial (the function body never read it). The
      // org check now happens inside the RPC against amux.current_org_id().
      const { data, error } = await supabase.rpc("join_public_team", {
        p_team_id: teamId,
        p_default_org_id: null,
      });
      if (error) {
        const code = error?.code || "";
        if (code === "42501") throw new ApiError(403, "forbidden", error.message ?? "team is not joinable");
        if (code === "P0002") throw new ApiError(404, "not_found", error.message ?? "team not found");
        throw error;
      }
      const row = requiredRow(data, "teams.joinPublicTeam");
      return mapTeam({
        id: row.team_id ?? row.id,
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
        const { data: provisioned, error: orgErr } =
          await supabase.rpc("ensure_personal_org");
        if (orgErr) throw orgErr;
        fallbackOrg = (provisioned as string | null) ?? null;
      }
      const { data, error } = await supabase.rpc("create_team", {
        p_name: input.name ?? null,
        p_slug: input.slug ?? null,
        p_display_name: input.displayName ?? null,
        p_litellm_team_id: input.litellmTeamId ?? null,
        p_ai_gateway_endpoint: input.aiGatewayEndpoint ?? null,
        p_oid: fallbackOrg,
      });
      if (error) throw error;
      const row = requiredRow(data, "teams.createTeam");
      return mapTeam({
        id: row.team_id ?? row.id,
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
      const { data, error } = await supabase.rpc("bootstrap_login_team", {
        // FC-layer enforcement, deliberately. See FeatureFlags.allowNewOrg.
        p_allow_new_org: newOrgAllowed(),
        // The partner tenant is frozen on the old behaviour: phone-auth stamps
        // this org, and without the exclusion belayo's phone users would all be
        // funnelled into one shared default team.
        p_shared_org: process.env.DEFAULT_ORG_ID || null,
        p_display_name: input?.displayName ?? null,
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
      return mapTeam({ id: row.team_id ?? row.id, name: row.team_name ?? row.name, slug: row.team_slug ?? row.slug });
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

    // Phone identity upgrade (partner-aligned): bind a phone to the caller's
    // account via our own verification code + a public.users row in the default
    // org (NOT GoTrue phone_change). See bind_phone_to_account RPC.
    async bindPhone({ phone, code }) {
      const defaultOrgId = process.env.DEFAULT_ORG_ID || null;
      // Match send-code's canonical bare 11-digit form so the verify-code lookup
      // (and the stored public.users.mobile) line up; clients send E.164 +86….
      const { data, error } = await supabase.rpc("bind_phone_to_account", {
        p_phone: normalizePhone(phone),
        p_code: code,
        p_default_org_id: defaultOrgId,
      });
      if (error) {
        const c = error?.code || "";
        if (c === "42501") throw new ApiError(403, "forbidden", error.message ?? "not allowed");
        if (c === "23505") throw new ApiError(409, "conflict", error.message ?? "phone already in use");
        if (c === "23514") throw new ApiError(400, "validation_failed", error.message ?? "invalid bind");
        throw new ApiError(400, "validation_failed", error.message ?? "phone bind failed");
      }
      const row = requiredRow(data, "account.bindPhone");
      return { userId: requiredString(row.user_id, "account.bindPhone", "user_id"), bound: Boolean(row.bound) };
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
      // Explicit amux schema: client default is already amux, but keep this
      // belt-and-suspenders so we never resolve a stale public.remove_team_actor.
      const { error } = await supabase
        .schema("amux")
        .rpc("remove_team_actor", { p_actor_id: actorId });
      if (error) throw error;

      // Best-effort: delete the removed actor's LiteLLM key (replaces the
      // legacy POST /ai/remove-member endpoint). Never blocks/fails actor
      // removal — deleteMemberKey swallows its own errors, and we also guard
      // the dynamic import itself so a module-resolution failure can't throw
      // out of an already-committed removal (parity with pg-repo).
      try {
        const { deleteMemberKey } = await import("./team-provisioning.js");
        await deleteMemberKey(actorId);
      } catch (e) {
        console.warn("[removeTeamActor] LiteLLM key cleanup skipped:", (e as any)?.message);
      }
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


    async setupLiteLlm(teamId) {
      // Lazy import keeps the LiteLLM client out of cold-path repo constructors
      // and makes it trivial to inject in tests via options.provisionLiteLlm.
      // Persist litellm_team_id + ai_gateway_endpoint via SECURITY DEFINER
      // RPC because team_workspace_config.litellm_team_id is guarded against
      // direct authenticated UPDATEs (see 20260527000004 guard trigger).
      const provisioning = await provisionLiteLlmForTeam(teamId);
      return {
        aiGatewayEndpoint: provisioning.aiGatewayEndpoint,
        litellmKey: provisioning.litellmKey,
      };
    },

    // Idempotently issues the CALLER's own per-member LiteLLM virtual key,
    // auto-provisioning the team's LiteLLM team first if it hasn't been set
    // up yet (A2-1). There is intentionally NO actorId parameter: the caller
    // can only ever provision a key for themselves, resolved team-scoped via
    // requireCallerTeamMemberActor (401 if unauthenticated, 403 if not a
    // member of teamId).
    async ensureMemberKey(teamId) {
      const actorId = await requireCallerTeamMemberActor(teamId);

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      let litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        // provisionLiteLlmForTeam persists the LiteLLM-generated team_id (from
        // provisionTeamLiteLLM's POST /team/new) into team_workspace_config —
        // NOT a deterministic `tc-${teamId}` value — so we take the id
        // straight from its return value rather than reconstructing it.
        const provisioning = await provisionLiteLlmForTeam(teamId);
        litellmTeamId = provisioning.litellmTeamId;
      }
      if (!litellmTeamId) {
        throw new ApiError(
          502,
          "litellm_team_id_missing",
          "LiteLLM team id was not persisted after setup",
        );
      }

      const { ensureMemberKeyFor } = await import("./team-provisioning.js");
      return ensureMemberKeyFor(litellmTeamId, actorId);
    },

    // Team-wide LiteLLM token + spend usage from the migrated LiteLLM RDS.
    // Any team member may read. The LiteLLM team id is NOT a deterministic
    // `tc-${teamId}` value — it's provisioner-generated and persisted into
    // team_workspace_config.litellm_team_id by setupLiteLlm/ensureMemberKey
    // (see the read pattern mirrored from ensureMemberKey above). If the team
    // has never provisioned LiteLLM, return an empty usage shape without
    // querying LiteLLM.
    async getLiteLlmUsage(teamId, opts: { range?: string; date?: string } = {}) {
      await requireCallerTeamMember(teamId);
      const range = computeRange((opts.range ?? "month") as any, opts.date);

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      const litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        return {
          litellmTeamId: null,
          range: range.range,
          startDate: range.startDate,
          endDate: range.endDate,
          startUtc: range.startUtc,
          endUtc: range.endUtc,
          summary: {
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalSpend: 0,
            requestCount: 0,
          },
          maxBudget: null,
          members: [],
          byModel: [],
        };
      }

      const usage = await queryLiteLlmUsage(litellmTeamId, range);
      return {
        ...usage,
        members: await rollUpUsageByOwner(usage.members ?? [], (ids) => resolveOwnersForTeam(supabase, teamId, ids)),
      };
    },

    // Lists the team's LiteLLM virtual keys (masked). Any team member may
    // read — resolved via requireCallerTeamMemberActor (401/403). The
    // LiteLLM team id is NOT a deterministic `tc-${teamId}` value; it's
    // provisioner-generated and persisted into
    // team_workspace_config.litellm_team_id (see ensureMemberKey/getLiteLlmUsage
    // above). If the team has never provisioned LiteLLM, return an empty
    // keys list without calling LiteLLM.
    async listLiteLlmKeys(teamId) {
      await requireCallerTeamMemberActor(teamId);

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      const litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        return { teamId: null, keys: [] };
      }

      const fetcher = litellmFetchOpt ?? sharedLitellmFetch;
      const res = await fetcher(`/team/info?team_id=${litellmTeamId}`, "GET");
      if (!res.ok) {
        throw new ApiError(502, "litellm_error", "Failed to fetch team info from LiteLLM");
      }
      const keys = ((res.data as any)?.keys || []).map((k: any) => ({
        key: k.token ? `${k.token.slice(0, 10)}...` : "",
        alias: k.key_alias || "",
        spend: k.spend || 0,
        created_at: k.created_at || "",
      }));
      return { teamId: litellmTeamId, keys };
    },

    // Sets the team's LiteLLM max budget. Owner-only — resolved via
    // requireCallerTeamOwner (401/403). The LiteLLM team id is read from the
    // persisted team_workspace_config.litellm_team_id, NEVER reconstructed as
    // `tc-${teamId}`. If the team has never provisioned LiteLLM, throws 409
    // litellm_not_provisioned rather than implicitly setting it up — owner
    // intent must be explicit (call /litellm/setup first).

    // ── team credits ────────────────────────────────────────────────────────
    // Every read and write goes through the AI gateway rather than these
    // tables directly: it is the ledger's only writer (design §4.9.1), and
    // routing reads the same way keeps period boundaries and shapes identical
    // on both sides of the billing screen.
    //
    // Permission split per §12.6: balance and usage are visible to every
    // member — an exhausted wallet stops their work, so they must be able to
    // see why — while the ledger and every mutation are owner-only.

    /**
     * Resolve actor ids in a usage report to display names.
     *
     * Done here rather than in the gateway: the gateway owns spend, not how a
     * person is presented. It also has no business reading the actor directory
     * — its grant is deliberately narrow.
     */
    async _nameUsageActors(teamId: string, report: any) {
      const ids = (report?.byActor ?? []).map((r: any) => r.actorId).filter(Boolean);
      if (!ids.length) return report;
      const names = await (async () => {
        const { data } = await supabase
          .from("actors").select("id, display_name")
          .eq("team_id", teamId).in("id", ids);
        return new Map((data ?? []).map((r: any) => [r.id, r.display_name]));
      })();
      return {
        ...report,
        byActor: report.byActor.map((r: any) => ({
          ...r,
          // null display name = the unattributed bucket; the UI renders a
          // localized label rather than a raw uuid.
          displayName: r.actorId ? (names.get(r.actorId) ?? null) : null,
        })),
      };
    },
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
      return this._nameUsageActors(teamId, await aiGateway.usage(teamId, opts));
    },
    async getCreditLedger(teamId: string, opts: { limit?: number } = {}) {
      await requireCallerTeamOwner(teamId);
      return aiGateway.ledger(teamId, opts.limit);
    },
    async topUpCredits(teamId: string, input: any) {
      await requireCallerTeamOwner(teamId);
      const amount = Number(input?.amountCredits);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new ApiError(400, "invalid_request", "amountCredits must be a positive integer");
      }
      // Required rather than generated here: an idempotency key the server
      // invents is a new key on every retry, which defeats the point.
      if (!input?.idempotencyKey) {
        throw new ApiError(400, "invalid_request", "idempotencyKey is required");
      }
      return aiGateway.topUp(teamId, {
        amountCredits: amount,
        kind: input.kind ?? "top_up",
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
      });
    },
    async listCreditPackages(teamId: string) {
      await requireCallerTeamMember(teamId);
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

    async setLiteLlmBudget(teamId, { maxBudget }: { maxBudget?: unknown } = {}) {
      await requireCallerTeamOwner(teamId);

      if (maxBudget === undefined || maxBudget === null || Number.isNaN(Number(maxBudget))) {
        throw new ApiError(400, "missing_maxBudget", "maxBudget is required and must be numeric");
      }

      const { data: cfg, error: cfgErr } = await supabase
        .from("team_workspace_config")
        .select("litellm_team_id")
        .eq("team_id", teamId)
        .maybeSingle();
      if (cfgErr) throw cfgErr;

      const litellmTeamId = cfg?.litellm_team_id ?? null;
      if (!litellmTeamId) {
        throw new ApiError(409, "litellm_not_provisioned", "team has not provisioned LiteLLM");
      }

      const fetcher = litellmFetchOpt ?? sharedLitellmFetch;
      const res = await fetcher("/team/update", "POST", {
        team_id: litellmTeamId,
        max_budget: Number(maxBudget),
      });
      if (!res.ok) {
        throw new ApiError(502, "litellm_error", "Failed to update LiteLLM budget");
      }

      return { maxBudget: Number(maxBudget) };
    },

    async getWorkspaceConfig(teamId) {
      const { data: configData, error: configError } = await supabase
        .from("team_workspace_config")
        .select("sync_mode, litellm_team_id, ai_gateway_endpoint, llm_enabled, llm_base_url, llm_models")
        .eq("team_id", teamId)
        .maybeSingle();
      if (configError) throw configError;
      const configRes = { data: configData };
      const aiGatewayEndpoint = configRes.data?.ai_gateway_endpoint ?? null;
      // availableModels proxies the LiteLLM gateway GET /v1/models (the gateway
      // authoritatively lists its models) and degrades to [] whenever the
      // dep/endpoint/credential is missing or the call throws — it must never
      // fail the workspace-config request. FC does not persist a per-team
      // LiteLLM key, so the FC-level LITELLM_MASTER_KEY is used (same credential
      // setupLiteLlm/provisioning uses; the catalogue is gateway-wide).
      let availableModels: Array<{ id: string; name: string }> = [];
      try {
        if (aiGatewayEndpoint) {
          const fetcher =
            fetchLiteLlmModelsOpt ??
            (await import("./team-provisioning.js")).fetchLiteLlmModels;
          const key = process.env.LITELLM_MASTER_KEY || "";
          if (fetcher && key) {
            const out = await fetcher(aiGatewayEndpoint, key);
            if (Array.isArray(out)) availableModels = out;
          }
        }
      } catch {
        availableModels = [];
      }
      const storedModels = Array.isArray(configRes.data?.llm_models) ? configRes.data.llm_models : [];
      return {
        syncMode: configRes.data?.sync_mode ?? null,
        litellmTeamId: configRes.data?.litellm_team_id ?? null,
        // `models` is the STORED, authoritative per-team list; `availableModels`
        // is the optional gateway picker source.
        llm: {
          enabled: configRes.data?.llm_enabled ?? false,
          baseUrl: configRes.data?.llm_base_url ?? null,
          models: storedModels,
          availableModels,
          aiGatewayEndpoint,
        },
      };
    },

    async setLlmConfig(teamId, input) {
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
      return { items: (data ?? []).map(mapDirectoryActor) };
    },

    async getTeamDirectory(teamId) {
      // Column names here are PostgREST aliases, not a rename: `actor_directory`
      // exposes the discriminator as `actor_type` and `team_members` keys the
      // actor as `member_id`. Selecting the mapper-side names directly (`kind`,
      // `actor_id`) made this endpoint a guaranteed 500 — "column
      // actor_directory.kind does not exist" — at any team size. Aliasing keeps
      // mapActor/mapTeamMember and the response shape untouched.
      const [actorsRes, membersRes] = await Promise.all([
        supabase
          .from("actor_directory")
          .select("id, team_id, kind:actor_type, display_name, avatar_url")
          .eq("team_id", teamId)
          .or(LISTABLE_AGENT_STATUS_OR_FILTER),
        supabase
          .from("team_members")
          .select("actor_id:member_id, team_id, role, joined_at")
          .eq("team_id", teamId),
      ]);
      if (actorsRes.error) throw actorsRes.error;
      if (membersRes.error) throw membersRes.error;
      return {
        actors: (actorsRes.data ?? []).map(mapActor),
        members: (membersRes.data ?? []).map(mapTeamMember),
      };
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

    async insertMessage(sessionId, input) {
      const { data, error } = await supabase
        .from("messages")
        .insert(outgoingMessageRow(sessionId, input))
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) throw error;

      if (dispatchPush) {
        dispatchPush({
          id: data.id,
          session_id: data.session_id,
          team_id: data.team_id,
          sender_actor_id: data.sender_actor_id ?? null,
          kind: data.kind ?? "text",
          content: data.content ?? "",
        }).catch((err: unknown) => {
          console.error("[push] dispatchPush failed (swallowed):", err);
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
        query = query.lt("updated_at", cursor.updatedAt);
      }
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapWorkspace) };
    },

    async upsertWorkspace(input) {
      // AUTHZ: created_by is ALWAYS resolved server-side from the authenticated
      // caller scoped to the target team. Any client-supplied
      // `input.createdByMemberId` is ignored — a multi-team user's client can
      // send the wrong team's member actor id (stale current-team value), which
      // the workspaces INSERT RLS WITH CHECK then rejects. Deriving it here
      // guarantees the row satisfies the team-scoped policy regardless of what
      // the client sends (mirrors createSession / createApp).
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const resolved = await this.resolveCurrentMemberActor(input.teamId, userId);
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByMemberId = resolved.id;

      // Dedup key: explicit `id` always wins. Otherwise reuse by (team, path)
      // or by (team, agent, name) — the table's unique constraint is
      // (team_id, agent_id, name), and onConflict:"id" alone mints a fresh
      // UUID that collides with that constraint when re-adding an existing /
      // archived workspace. Mirrors pg-repo/workspaces.ts.
      let targetId = input.id ?? null;
      const normalizedPath = normalizeWorkspacePath(input.path ?? input.slug ?? null);
      let resolvedName = input.name;

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
        byNameQuery = input.agentId
          ? byNameQuery.eq("agent_id", input.agentId)
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
              input.agentId,
              resolvedName,
            );
          }
        }
      }

      const row: Record<string, unknown> = {
        team_id: input.teamId,
        name: resolvedName,
        path: normalizedPath,
        agent_id: input.agentId ?? null,
        created_by_member_id: createdByMemberId,
        archived: input.archived ?? false,
      };
      if (targetId) row.id = targetId;

      const { data, error } = await supabase
        .from("workspaces")
        .upsert(row, { onConflict: "id" })
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) throw error;
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
      if (patch.slug !== undefined) row.path = patch.slug;
      if (patch.path !== undefined) row.path = patch.path;
      if (patch.agentId !== undefined) row.agent_id = patch.agentId;
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
        await archiveSessionsForWorkspace(supabase, workspaceId);
      }
      return mapWorkspace(data);
    },

    async getTeamWorkspaceConfig(teamId) {
      const { data, error } = await supabase
        .from("team_workspace_config")
        .select("team_id, default_workspace_id, pinned_workspace_ids, updated_at")
        .eq("team_id", teamId)
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        teamId: requiredString(row.team_id, "workspaces.getTeamWorkspaceConfig", "team_id"),
        defaultWorkspaceId: row.default_workspace_id ?? null,
        pinnedWorkspaceIds: row.pinned_workspace_ids ?? [],
        updatedAt: row.updated_at ?? null,
      };
    },

    async putTeamWorkspaceConfig(teamId, input) {
      const row = {
        team_id: teamId,
        default_workspace_id: input.defaultWorkspaceId ?? null,
        pinned_workspace_ids: input.pinnedWorkspaceIds ?? [],
      };
      const { data, error } = await supabase
        .from("team_workspace_config")
        .upsert(row, { onConflict: "team_id" })
        .select("team_id, default_workspace_id, pinned_workspace_ids, updated_at")
        .single();
      if (error) throw error;
      return {
        teamId: requiredString(data.team_id, "workspaces.putTeamWorkspaceConfig", "team_id"),
        defaultWorkspaceId: data.default_workspace_id ?? null,
        pinnedWorkspaceIds: data.pinned_workspace_ids ?? [],
        updatedAt: data.updated_at ?? null,
      };
    },

    async writeForegroundPresence({ deviceId, foregroundUntil }) {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
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
      const { data: userData, error: userErr } = await supabase.auth.getUser();
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
      const { data: prefUser, error: prefUserErr } = await supabase.auth.getUser();
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
      let query = supabase
        .from("ideas")
        .select("*")
        .eq("team_id", teamId)
        .eq("archived", archived)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (cursor?.updatedAt) {
        query = query.lt("updated_at", cursor.updatedAt);
      }
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapIdeaRow) };
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
      return this.getIdea(id);
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

    async setShortcutVisibleRoles(shortcutId, { roleIds }) {
      const { error } = await supabase.rpc("shortcut_set_visible_roles", {
        p_shortcut_id: shortcutId,
        p_role_ids: roleIds,
      });
      if (error) throw error;
    },

    async listTeamRoles(teamId) {
      const { data, error } = await supabase
        .from("team_roles")
        .select("id, team_id, code, name")
        .eq("team_id", teamId);
      if (error) throw error;
      return (data ?? []).map((r) => ({ id: r.id, teamId: r.team_id, code: r.code, name: r.name }));
    },

    async listTeamPermissions(teamId) {
      const { data, error } = await supabase
        .from("permissions")
        .select("resource_id, permission_roles(role_id)")
        .eq("team_id", teamId);
      if (error) throw error;
      return (data ?? []).map((r) => ({ resourceId: r.resource_id, roleIds: (r.permission_roles ?? []).map((x) => x.role_id) }));
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
      const { data: authData, error: authErr } = await supabase.auth.getUser();
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
      return {
        path,
        url: `${supabasePublicUrl}/storage/v1/object/public/${targetBucket}/${path}`,
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
      const { data, error } = await supabase
        .rpc("team_leaderboard", { p_team_id: teamId, p_period: period });
      if (error) throw error;
      const rows = (data ?? []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return { items: rows.map(mapLeaderboardRow) };
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
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) return null;
      return this.resolveCurrentActor(teamId, userId);
    },

    // The caller's single actor in this team regardless of `actor_type`.
    // `actors_team_user_idx` guarantees at most one actor per (team, user), so
    // this is unambiguous: a human resolves to their member actor, a daemon
    // resolves to its agent actor.
    async resolveCurrentActor(teamId, userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id } : null;
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
        .select("id, display_name, team_role")
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
      return {
        id: actor.id,
        displayName: actor.display_name || "",
        role: actor.team_role ?? null,
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
          "id, team_id, actor_type, display_name, member_status, agent_status, last_active_at, created_at, updated_at",
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
      return rows.map(mapDirectoryActor);
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
          .upsert(rows, { onConflict: "session_id,actor_id" });
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
      return chunkedIn(workspaceIds, async (chunk) => {
        const { data, error } = await supabase
          .from("workspaces")
          .select("id, name, path")
          .eq("team_id", teamId)
          .in("id", chunk);
        if (error) throw error;
        return data ?? [];
      });
    },

    async listShortcutRoleBindings(teamId) {
      const { data, error } = await supabase
        .from("permissions")
        .select("resource_id, permission_roles(role_id)")
        .eq("team_id", teamId)
        .eq("resource_type", "shortcut");
      if (error) throw error;
      return data ?? [];
    },

    async loadTeamWorkspaceGitConfig(teamId) {
      const { data, error } = await supabase
        .from("team_workspace_config")
        .select("team_id, git_url, git_branch, git_token, ai_gateway_endpoint, enabled, updated_at")
        .eq("team_id", teamId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    async saveTeamWorkspaceGitConfig(input) {
      const { error } = await supabase
        .from("team_workspace_config")
        .upsert(input, { onConflict: "team_id" });
      if (error) throw error;
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
      const { error } = await supabase.rpc("join_session", { p_session_id: sessionId });
      if (error) {
        if (error.code === "P0002") throw new ApiError(404, "not_found", "session not found");
        if (error.code === "42501") throw new ApiError(403, "forbidden", "not a member of this session's team");
        throw error;
      }
      // The caller is now a participant, so RLS lets getSession read the row.
      const session = await this.getSession(sessionId);
      if (!session) throw new ApiError(404, "not_found", "session not found");
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
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const resolved = await this.resolveCurrentMemberActor(input.teamId, userId);
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByActorId = resolved.id;
      const insertRow: any = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        idea_id: input.ideaId ?? null,
        created_by_actor_id: createdByActorId,
      };
      // App-linked sessions carry app_id so listAppSessions / the app workspace
      // can resolve them (mirrors pg-repo createSession). Omitted for plain
      // sessions so the column stays NULL.
      if (input.appId) insertRow.app_id = input.appId;
      if (input.primaryAgentId) insertRow.primary_agent_id = input.primaryAgentId;
      const { data, error } = await supabase
        .from("sessions")
        .insert(insertRow)
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (error) throw error;

      const additionalIds = Array.isArray(input.additionalActorIds) ? input.additionalActorIds : [];
      const participantIds = Array.isArray(input.participantActorIds) ? input.participantActorIds : [];
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
        const rows = seedActorIds.map((actorId) => ({ session_id: id, actor_id: actorId }));
        const { error: partError } = await supabase
          .from("session_participants")
          .upsert(rows, { onConflict: "session_id,actor_id" });
        if (partError) throw partError;
      }
      return mapSessionFull(data);
    },

    async patchSession(sessionId, patch) {
      const update: any = {};
      if (patch.title !== undefined) update.title = patch.title;
      if (patch.summary !== undefined) update.summary = patch.summary;
      if (patch.archivedAt !== undefined) update.archived_at = patch.archivedAt;
      if (patch.mode !== undefined) update.mode = patch.mode;
      if (Object.keys(update).length === 0) {
        return this.getSession(sessionId);
      }
      const { data, error } = await supabase
        .from("sessions")
        .update(update)
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
    },

    async markSessionUnread(sessionId) {
      // Delete the caller's read marker so the session re-derives as unread.
      // RLS scopes the delete to the current actor via the "write own markers"
      // FOR ALL policy, so no explicit actor filter is needed here.
      const { error } = await supabase
        .from("session_read_markers")
        .delete()
        .eq("session_id", sessionId);
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
      return {
        sessionId: row.session_id ?? row.sessionId ?? null,
        // The amuxd daemon deserializes `gatewaySessionId` as a REQUIRED field
        // and uses it as the logical ACP session id it later looks up via
        // getSessionByAcp (which queries the acp_session_id column) — so it must
        // equal acp_session_id to round-trip. Omitting it made WeCom inbound
        // messages fail with "missing field gatewaySessionId". The pg-repo
        // backend already returns this field; this keeps the two in lockstep.
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
      // Bootstrap primary agent as participant.
      const { error: partError } = await supabase
        .from("session_participants")
        .upsert(
          [{ session_id: id, actor_id: input.primaryAgentActorId }],
          { onConflict: "session_id,actor_id" },
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
            { onConflict: "session_id,actor_id" },
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
        .select("id, team_id, title")
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

      return {
        sessionId,
        callerActorId,
        title: sessionRow.title ?? null,
        selfAgent,
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
      const { error: insertError } = await supabase
        .from("session_participants")
        .upsert(row, { onConflict: "session_id,actor_id", ignoreDuplicates: true });
      if (insertError) throw insertError;
      // `ignoreDuplicates` returns no rows for the conflict case, so the read
      // is separate rather than chained off the write.
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id, actor_id, role, joined_at")
        .eq("session_id", sessionId)
        .eq("actor_id", input.actorId)
        .single();
      if (error) throw error;
      return {
        sessionId: data.session_id,
        actorId: data.actor_id,
        role: data.role ?? null,
        joinedAt: data.joined_at ?? null,
      };
    },

    async updateParticipantCursor(sessionId, actorId, { lastProcessedMessageId }) {
      const { error } = await supabase
        .from("session_participants")
        .update({
          last_processed_message_id: lastProcessedMessageId,
          updated_at: new Date().toISOString(),
        })
        .eq("session_id", sessionId)
        .eq("actor_id", actorId);
      if (error) throw error;
    },

    /**
     * Which model this agent runs on in this session.
     *
     * The column landed with the ADR-0005 migration alongside `workspace_id`
     * and the cursor, but only those two got writers: `model` was backfilled
     * from `agent_runtimes.current_model` and then never touched again, so
     * every reader trusting the ADR got a frozen value. This is that writer.
     */
    async updateParticipantModel(sessionId, actorId, { model }) {
      const { error } = await supabase
        .from("session_participants")
        .update({ model, updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("actor_id", actorId);
      if (error) throw error;
    },

    async removeSessionParticipant(sessionId, actorId) {
      const { error } = await supabase
        .from("session_participants")
        .delete()
        .eq("session_id", sessionId)
        .eq("actor_id", actorId);
      if (error) throw error;
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
      const actor = mapDirectoryActor(data);
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
        // lands here rather than in a migration — same rule as the pg-repo twin.
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





    // --- Apps domain (production passthrough) ---
    //
    // With the caller's bearer forwarded, RLS already enforces visibility on
    // amux.apps / amux.sessions, so these methods are THINNER than pg-repo:
    // no manual visibility WHERE clause. Status transitions in createApp mirror
    // pg-repo exactly. mapApp exposes the canonical 12-key contract shape.

    async listApps({ teamId, limit = 100 }: { teamId: string; limit?: number }) {
      const { data, error } = await supabase
        .from("apps")
        .select(APP_COLUMNS)
        .eq("team_id", teamId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(mapApp);
    },

    async getApp(appId: string) {
      // RLS returns nothing (PGRST116 on .single()) when the app is not
      // visible to the caller; surface that as null so the route 404s.
      const { data, error } = await supabase
        .from("apps")
        .select(APP_COLUMNS)
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapApp(data) : null;
    },

    async createApp(input: {
      teamId: string;
      name: string;
      type: string;
      visibility?: string;
      gitRemoteUrl?: string | null;
    }) {
      // Resolve the caller's actor in this team — the RLS insert policy
      // (created_by_actor_id = app.current_actor_id_for_team(team_id)) requires
      // it. Reuse the same mechanism createSession uses (auth.getUser +
      // resolveCurrentMemberActor) so both paths satisfy the same policy.
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const resolved = await this.resolveCurrentMemberActor(input.teamId, userId);
      if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
      const createdByActorId = resolved.id;
      const slug = slugify(input.name);
      const visibility = input.visibility === "team" ? "team" : "personal";
      const importUrl = input.gitRemoteUrl?.trim() || null;
      if (!importUrl && !gitea) throw giteaUnavailable(giteaUnavailableReason);

      // 1:1 workspace for the app. created_by_member_id = the resolved actor so
      // the workspace RLS insert policy is satisfied (same actor identity).
      const { data: ws, error: wsErr } = await supabase
        .from("workspaces")
        .insert({
          team_id: input.teamId,
          created_by_member_id: createdByActorId,
          name: `app-${slug}-${Math.random().toString(36).slice(2, 8)}`,
        })
        .select("id")
        .single();
      if (wsErr) throw wsErr;

      const { data: row, error: appErr } = await supabase
        .from("apps")
        .insert({
          team_id: input.teamId,
          created_by_actor_id: createdByActorId,
          name: input.name,
          slug,
          type: input.type,
          visibility,
          workspace_id: ws.id,
          git_remote_url: importUrl,
          provision_status: "pending",
        })
        .select(APP_COLUMNS)
        .single();
      if (appErr) throw appErr;

      if (importUrl) return mapApp(row);

      try {
        // The SSH URL, not `clone_url`: the deploy key is the only credential
        // we hand out for this repo, and it is useless over HTTPS.
        const { sshUrl } = await gitea!.createAppRepo(row.id);
        const { data: updated, error: updErr } = await supabase
          .from("apps")
          .update({
            git_remote_url: sshUrl,
            git_auth_kind: GITEA_AUTH_KIND,
            provision_status: "repo_created",
            provision_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .select(APP_COLUMNS)
          .single();
        if (updErr) throw updErr;
        return mapApp(updated);
      } catch (e: unknown) {
        const msg = e instanceof ApiError ? e.message : String((e as Error)?.message ?? e);
        const { data: errored, error: errUpd } = await supabase
          .from("apps")
          .update({
            provision_status: "error",
            provision_error: msg,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .select(APP_COLUMNS)
          .single();
        if (errUpd) throw errUpd;
        if (e instanceof ApiError) throw e;
        // `details`, not a bare 4th-argument object — ApiError reads only
        // `options.details` / `options.cause`, so the errored row was dropped.
        throw new ApiError(502, "gitea_provision_failed", msg, {
          details: { app: mapApp(errored) },
        });
      }
    },

    async updateApp(
      appId: string,
      patch: {
        name?: string;
        visibility?: string;
        provisionStatus?: string;
        fcStatus?: string;
        deployError?: string;
        authMode?: string;
      },
    ) {
      // RLS apps_update_if_creator blocks non-creators: the UPDATE matches zero
      // rows and .maybeSingle() returns null → surface as null (route 404s).
      const { data: cur } = await supabase
        .from("apps")
        .select(
          "provision_status, fc_status, name, slug, auth_mode, oauth_client_id, oauth_app_id, team_id, created_by_actor_id",
        )
        .eq("id", appId)
        .maybeSingle();
      // Authorize BEFORE any side effect, not after.
      //
      // `apps_select_if_visible` lets any teammate read a team-visible app,
      // while `apps_update_if_creator` gates the write. Running the auth-mode
      // change first meant a non-creator's PATCH deleted the app's GoTrue
      // client (a hard DELETE) and its sealed secret with a service-role
      // client, and only then matched zero rows and answered 404 — the live
      // app's login destroyed by a request the API called "not found".
      //
      // The gate is `admin`, not creator: design §5.2 gives admin grantees
      // authMode plus deploy, and a grantee who can deploy must also be able to
      // write `fc_status` back — otherwise their own deploy is stranded at
      // `awaiting_build` forever with nothing able to report the failure.
      // Not visible to the caller under `apps_select_if_visible` → 404, and
      // emphatically no escalation: a row we cannot read is not one we may
      // write with a service-role client.
      if (!cur) return null;
      const callerPermission = await this.resolveAppCallerPermissionForApp({
        id: appId,
        team_id: cur.team_id,
        created_by_actor_id: cur.created_by_actor_id,
      });
      if (callerPermission?.level !== "admin") return null;
      const callerIsCreator = await this.isAppCreator(cur.team_id, cur.created_by_actor_id);

      const set: any = { updated_at: new Date().toISOString() };
      if (typeof patch.name === "string" && patch.name.length > 0) set.name = patch.name;
      if (patch.visibility === "team" || patch.visibility === "personal") {
        set.visibility = patch.visibility;
      }

      const nextAuthMode = parseAuthMode(patch.authMode);
      if (nextAuthMode !== undefined && cur) {
        const fromAuthMode = (cur.auth_mode ?? "none") as AuthMode;
        if (nextAuthMode !== fromAuthMode) {
          const admin = await serviceRoleClient("store app secrets");
          const oauth = await applyAuthModeChange(
            {
              gotrue,
              gotrueUnavailableReason,
              secrets: {
                putSecret: (kind, plaintext) => putAppSecretSupabase(admin, appId, kind, plaintext),
                deleteSecret: (kind) => deleteAppSecretSupabase(admin, appId, kind),
              },
            },
            {
              appId,
              name: cur.name,
              slug: cur.slug,
              from: fromAuthMode,
              to: nextAuthMode,
              oauthClientId: cur.oauth_client_id ?? null,
              oauthAppId: cur.oauth_app_id ?? null,
            },
          );
          set.auth_mode = nextAuthMode;
          set.oauth_client_id = oauth.oauthClientId;
          set.oauth_app_id = oauth.oauthAppId;
        }
      }

      if (typeof patch.provisionStatus === "string") {
        const from = cur?.provision_status ?? "";
        if (isLegalStatusTransition(from, patch.provisionStatus)) {
          set.provision_status = patch.provisionStatus;
        } else if (set.name === undefined && set.visibility === undefined) {
          throw new ApiError(400, "invalid_status_transition",
            `cannot move provision_status ${from} -> ${patch.provisionStatus}`);
        }
      }
      // Deploy-lifecycle writeback — the desktop owns the daemon-build step of
      // the deploy, so it is the only party that can report that the build never
      // finished. Without it the row stayed at `awaiting_build` indefinitely.
      if (typeof patch.fcStatus === "string") {
        if (!isLegalFcTransition(cur?.fc_status, patch.fcStatus)) {
          throw new ApiError(400, "invalid_deploy_transition",
            `cannot move fc_status ${cur?.fc_status ?? "not_deployed"} -> ${patch.fcStatus}`);
        }
        set.fc_status = patch.fcStatus;
        if (patch.fcStatus === "deploy_error") {
          set.provision_error = typeof patch.deployError === "string" && patch.deployError
            ? patch.deployError
            : "deploy failed";
        }
      }
      // The creator writes with their own token so RLS stays a second gate.
      // An `admin` grantee cannot: `apps_update_if_creator` is creator-only, so
      // their UPDATE would match zero rows and 404 despite being authorized.
      // Same escalation the sibling grant write uses (see setAppAccess).
      const writer = callerIsCreator
        ? supabase
        : await serviceRoleClient("apply an app update authorized by an admin grant");
      const { data, error } = await writer
        .from("apps")
        .update(set)
        .eq("id", appId)
        .select(APP_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? mapApp(data) : null;
    },

    async deployApp(appId: string, input: { gitCommitSha?: string }) {
      // Optional: only a Gitea-managed app pins its deploy to a forge commit.
      const gitCommitSha = parseOptionalGitCommitSha(input?.gitCommitSha);
      // Visibility + readiness gate. RLS on amux.apps returns nothing when the
      // app is not visible to the caller → surface null so the route 404s.
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, slug, team_id, created_by_actor_id, provision_status, runtime, auth_mode, fc_status, deploy_started_at")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level !== "admin") return null;
      if (existing.provision_status !== "ready") {
        throw new ApiError(409, "app_not_ready", "app must be seeded (provision_status=ready) before deploy");
      }
      assertDeployAllowed({ id: existing.id, slug: existing.slug, auth_mode: existing.auth_mode, runtime: existing.runtime });
      const progress = checkDeployInProgress({
        fc_status: existing.fc_status,
        deploy_started_at: existing.deploy_started_at,
      });
      if (progress === "blocked") {
        throw new ApiError(409, "deploy_in_progress", "a deploy is already in progress");
      }
      if (progress === "stale") {
        await supabase.from("apps").update({
          fc_status: "deploy_error",
          provision_error: "previous deploy timed out",
          deploy_token: null,
          deploy_started_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", appId);
      }
      if (!startDeploy) throw deployUnavailable(deployUnavailableReason);
      const deployToken = randomUUID();
      const deployStartedAt = new Date().toISOString();
      try {
        const r = await startDeploy({ appId, region: process.env.REGION || "cn-hangzhou" });
        const { data: row, error: updErr } = await supabase
          .from("apps")
          .update({
            fc_function_name: r.fcFunctionName,
            fc_region: r.fcRegion,
            fc_status: "awaiting_build",
            provision_error: null,
            deploy_token: deployToken,
            deploy_started_at: deployStartedAt,
            ...(gitCommitSha ? { git_commit_sha: gitCommitSha } : {}),
            updated_at: deployStartedAt,
          })
          .eq("id", appId)
          .select(APP_COLUMNS)
          .maybeSingle();
        if (updErr) throw updErr;
        if (!row) return null;
        return {
          ...mapApp(row),
          ossObjectName: r.ossObjectName,
          presignedPut: r.presignedPut,
          deployToken,
          gitCommitSha,
        };
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        await supabase
          .from("apps")
          .update({
            fc_status: "deploy_error",
            provision_error: String(e?.message ?? e),
            deploy_token: null,
            deploy_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId);
        throw new ApiError(502, "deploy_failed", String(e?.message ?? e));
      }
    },

    async finalizeDeploy(appId: string, input: { gitCommitSha?: string; deployToken: string }) {
      const gitCommitSha = parseOptionalGitCommitSha(input?.gitCommitSha);
      const deployToken = parseDeployToken(input?.deployToken);
      // Visibility gate. RLS on amux.apps returns nothing when the app is not
      // visible to the caller → surface null so the route 404s.
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, slug, team_id, org_id, created_by_actor_id, type, fc_function_name, fc_status, runtime, auth_mode, oauth_client_id, deploy_token")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level !== "admin") return null;
      if (!existing.deploy_token || existing.deploy_token !== deployToken) {
        throw new ApiError(409, "deploy_token_mismatch", "deployToken does not match the in-progress deploy");
      }
      assertDeployAllowed({ id: existing.id, slug: existing.slug, auth_mode: existing.auth_mode, runtime: existing.runtime });
      if (!existing.fc_function_name) throw new ApiError(409, "not_deploying", "app has no function; call deploy first");
      if (!isLegalFcTransition(existing.fc_status, "deploying")) {
        throw new ApiError(409, "invalid_deploy_state", `cannot finalize from fc_status ${existing.fc_status}`);
      }
      if (!finalizeDeploy) throw deployUnavailable(deployUnavailableReason);
      // Mark deploying (RLS-gated UPDATE).
      await supabase.from("apps").update({ fc_status: "deploying", updated_at: new Date().toISOString() }).eq("id", appId);
      try {
        let platformOAuthEnv: Record<string, string> | undefined;
        if ((existing.auth_mode ?? "none") === "platform") {
          const admin = await serviceRoleClient("read app secrets");
          platformOAuthEnv = await buildPlatformOAuthEnv(
            {
              gotrue,
              gotrueUnavailableReason,
              getSecret: (kind) => getAppSecretSupabase(admin, appId, kind),
            },
            { appId, slug: existing.slug, oauthClientId: existing.oauth_client_id ?? null },
          );
        }
        // Which database this app's data lives in is a fact decided once, at
        // the first successful finalize — not a property re-derived from the
        // team's CURRENT org. `teams.oid` is nullable and nothing guards it, so
        // re-deriving after it changes would provision a brand-new empty schema
        // in a different database and take the app live with no data. Deploy
        // where the data already is.
        const orgId = existing.org_id ?? (await this.resolveTeamOrgId(existing.team_id));
        const r = await finalizeDeploy({
          appId,
          slug: existing.slug,
          orgId,
          appType: existing.type,
          fcFunctionName: existing.fc_function_name,
          ossObjectName: appOssObjectName(appId),
          platformOAuthEnv,
        });
        const { data: row, error: updErr } = await supabase
          .from("apps")
          .update({
            fc_status: "live",
            fc_endpoint: r.fcEndpoint,
            ...(gitCommitSha ? { git_commit_sha: gitCommitSha } : {}),
            // The function that just went live carries this auth_mode's env.
            // Recording it here is what lets `authModePendingRedeploy` clear —
            // and what makes the pending state a property of the row rather
            // than of one desktop's memory.
            deployed_auth_mode: existing.auth_mode ?? "none",
            // Pin the org on the first success; a no-op on every later one.
            // Static apps have no schema anywhere, so they get no ledger entry
            // — a non-null org_id on one would claim data exists that does not.
            ...(orgId && needsDatabase(existing.type) ? { org_id: orgId } : {}),
            provision_error: null,
            deploy_token: null,
            deploy_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId)
          .select(APP_COLUMNS)
          .maybeSingle();
        if (updErr) throw updErr;
        if (!row) return null;
        return mapApp(row);
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        await supabase
          .from("apps")
          .update({
            fc_status: "deploy_error",
            provision_error: String(e?.message ?? e),
            deploy_token: null,
            deploy_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", appId);
        throw new ApiError(502, "finalize_failed", String(e?.message ?? e));
      }
    },

    /**
     * Resolve an app for the data browser: visibility, permission tier, whether
     * it has a database at all, and which one.
     *
     * Returns null for "the caller cannot see this app" so the route 404s —
     * indistinguishable, on purpose, from the app not existing.
     */
    async resolveAppDataTarget(
      appId: string,
      required: "prompt" | "admin",
    ): Promise<{ target: AppDataTarget } | null> {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, slug, team_id, org_id, type, fc_endpoint, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;

      const permission = await this.resolveAppCallerPermissionForApp(app);
      // `view` is not "read-only access to the data" — design §6 hides the
      // feature from that tier entirely, so it must not learn the app has one.
      if (!permission || permission.level === "view") return null;
      if (required === "admin" && permission.level !== "admin") {
        throw new ApiError(403, "forbidden", "editing this app's data requires admin access");
      }

      // Two distinct 409s, not one 404: the control panel shows a different
      // sentence for each, and "not found" would be a third, wrong story.
      if (!needsDatabase(app.type)) {
        throw new ApiError(409, "app_has_no_database", "this app type has no database");
      }
      if (!app.fc_endpoint) {
        throw new ApiError(409, "app_not_deployed", "the database is created by the first deploy");
      }

      let orgId = app.org_id ?? null;
      if (!orgId) {
        // A row that predates apps.org_id. Deriving is the best we can do and
        // it is the one case where we may be pointed at the wrong database
        // (design §3.1) — so it goes in the log, without any of the data.
        orgId = await this.resolveTeamOrgId(app.team_id);
        console.warn(`[apps] app ${appId} has no org_id; deriving it from the team`);
      }
      if (!orgId) {
        throw new ApiError(409, "app_org_unknown", "this app is not associated with an org database");
      }

      return { target: { orgId, appId: app.id, slug: app.slug } };
    },

    /** Shared guard: the ops facade is only present when FC has an admin URL. */
    requireAppData() {
      if (!appData) {
        throw new ApiError(
          503,
          "app_data_unavailable",
          appDataUnavailableReason
            ? `app data browsing is not configured: ${appDataUnavailableReason}`
            : "app data browsing is not configured",
        );
      }
      return appData;
    },

    async listAppDataTables(appId: string) {
      const resolved = await this.resolveAppDataTarget(appId, "prompt");
      if (!resolved) return null;
      const ops = this.requireAppData();
      return { items: await runAppData(() => ops.listTables(resolved.target)) };
    },

    async readAppDataRows(appId: string, table: string, query: any = {}) {
      const resolved = await this.resolveAppDataTarget(appId, "prompt");
      if (!resolved) return null;
      const ops = this.requireAppData();
      return runAppData(() =>
        ops.readRows(resolved.target, {
          table,
          after: typeof query.after === "string" ? query.after : null,
          direction: query.direction === "desc" ? "desc" : "asc",
          filter: parseAppDataFilter(query),
          limit: parsePageLimit(query.limit),
        }),
      );
    },

    async updateAppDataRow(appId: string, table: string, rowKey: string, body: any = {}) {
      const resolved = await this.resolveAppDataTarget(appId, "admin");
      if (!resolved) return null;
      const ops = this.requireAppData();
      const patch = body?.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new ApiError(400, "validation_failed", "patch must be an object of column values");
      }
      const row = await runAppData(() =>
        ops.updateRow(resolved.target, { table, key: decodeRowKey(rowKey), patch }),
      );
      return { row };
    },

    async deleteAppDataRow(appId: string, table: string, rowKey: string) {
      const resolved = await this.resolveAppDataTarget(appId, "admin");
      if (!resolved) return null;
      const ops = this.requireAppData();
      await runAppData(() => ops.deleteRow(resolved.target, { table, key: decodeRowKey(rowKey) }));
      return { ok: true };
    },

    async listAppSessions(appId: string) {
      // RLS on sessions governs visibility; a caller who cannot see the app's
      // sessions gets an empty list.
      const { data, error } = await supabase
        .from("sessions")
        .select("id, team_id, title, mode, last_message_at, created_at, updated_at")
        .eq("app_id", appId);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        teamId: r.team_id,
        title: r.title ?? "",
        mode: r.mode ?? "collab",
        lastMessageAt: appIso(r.last_message_at),
        createdAt: appIso(r.created_at)!,
        updatedAt: appIso(r.updated_at)!,
      }));
    },

    /**
     * Whether the caller is the actor that created this app.
     *
     * The creator-only gate for operations with side effects outside Postgres,
     * which RLS cannot roll back. RLS still has the last word on the write
     * itself; this only makes sure nothing irreversible happens first.
     */
    async isAppCreator(teamId: string, createdByActorId: string | null): Promise<boolean> {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const resolved = await this.resolveCurrentMemberActor(teamId, userId);
      return Boolean(resolved?.id) && createdByActorId === resolved!.id;
    },

    /**
     * `public.orgs.id` for a team (`amux.teams.oid`). Null when the team has
     * no org — data_app finalize then fails with a clear error rather than
     * inventing a shared database.
     */
    async resolveTeamOrgId(teamId: string): Promise<string | null> {
      const { data, error } = await supabase
        .from("teams")
        .select("oid")
        .eq("id", teamId)
        .maybeSingle();
      if (error) throw error;
      const oid = data?.oid;
      return typeof oid === "string" && oid.trim() ? oid.trim() : null;
    },

    /**
     * Effective per-app permission for the caller. Creator → admin; no access row
     * and not creator → null. Used for git credentials and deploy gates.
     */
    async resolveAppCallerPermissionForApp(app: {
      id: string;
      team_id: string;
      created_by_actor_id: string | null;
    }): Promise<{ level: "view" | "prompt" | "admin"; callerMemberId: string } | null> {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");

      const resolved = await this.resolveCurrentMemberActor(app.team_id, userId);
      if (!resolved?.id) return null;

      if (await this.isAppCreator(app.team_id, app.created_by_actor_id)) {
        return { level: "admin", callerMemberId: resolved.id };
      }

      const { data: access, error: accErr } = await supabase
        .from("app_member_access")
        .select("permission_level")
        .eq("app_id", app.id)
        .eq("member_id", resolved.id)
        .maybeSingle();
      if (accErr) throw accErr;
      const level = access?.permission_level;
      if (level === "view" || level === "prompt" || level === "admin") {
        return { level, callerMemberId: resolved.id };
      }
      return null;
    },

    async getAppGitCredential(appId: string) {
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, team_id, git_remote_url, git_auth_kind, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;

      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level === "view") return null;

      if (!existing.git_remote_url) return null;
      // An imported app has a remote this deployment holds no credential for;
      // minting a Gitea key for it would 404 on a repo that does not exist.
      if (existing.git_auth_kind !== GITEA_AUTH_KIND) return null;
      if (!gitea) throw giteaUnavailable(giteaUnavailableReason);

      const jit = await issueJitDeployKey(gitea, appId, permission.callerMemberId);
      return {
        remoteUrl: existing.git_remote_url,
        authKind: "deploy_key" as const,
        ...jit,
      };
    },

    async getAppGitHead(appId: string) {
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select("id, git_auth_kind")
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return null;
      if (existing.git_auth_kind !== GITEA_AUTH_KIND) return null;
      if (!gitea) throw giteaUnavailable(giteaUnavailableReason);
      return gitea.getRepoHead(appId);
    },

    async getAppMembership(appId: string) {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Bypass apps RLS: membership is team-scoped, not visibility-scoped. A
      // logged-in user checking access to a deployed app may not pass
      // apps_select_if_visible yet still need a truthful member/non-member answer.
      const admin = await serviceRoleClient("read app team for membership check");
      const { data: row, error } = await admin
        .from("apps")
        .select("id, team_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!row) return null;
      const resolved = await this.resolveCurrentMemberActor(row.team_id, userId);
      return { member: Boolean(resolved?.id) };
    },

    /**
     * Creator or `admin` grant on this app — required to list/set/remove access.
     * Returns null when the app is not visible or the caller lacks manage rights
     * (routes surface 404 to avoid leaking app existence).
     */
    async resolveAppAccessManager(appId: string): Promise<{ callerMemberId: string } | null> {
      const { data: app, error } = await supabase
        .from("apps")
        .select("id, team_id, created_by_actor_id")
        .eq("id", appId)
        .maybeSingle();
      if (error) throw error;
      if (!app) return null;

      const permission = await this.resolveAppCallerPermissionForApp(app);
      if (!permission || permission.level !== "admin") return null;
      return { callerMemberId: permission.callerMemberId };
    },

    async listAppAccess(appId: string) {
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      // RLS only exposes all rows to the creator; admin grantees see self only.
      // After the manage gate, read the full grant list with service role.
      const admin = await serviceRoleClient("list app member access");
      const { data, error } = await admin
        .from("app_member_access")
        .select("member_id, permission_level, granted_by_member_id, created_at")
        .eq("app_id", appId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapAppAccessRow);
    },

    async setAppAccess(appId: string, memberId: string, permissionLevel: string) {
      const level = parseAppPermissionLevel(permissionLevel);
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      // RLS manage policy is creator-only; admin grantees write via service role.
      const admin = await serviceRoleClient("manage app member access");
      const { data: priorAccess, error: priorErr } = await admin
        .from("app_member_access")
        .select("permission_level")
        .eq("app_id", appId)
        .eq("member_id", memberId)
        .maybeSingle();
      if (priorErr) throw priorErr;
      const now = new Date().toISOString();
      const { data, error } = await admin
        .from("app_member_access")
        .upsert(
          {
            app_id: appId,
            member_id: memberId,
            permission_level: level,
            granted_by_member_id: manager.callerMemberId,
            updated_at: now,
          },
          { onConflict: "app_id,member_id" },
        )
        .select("member_id, permission_level, granted_by_member_id, created_at")
        .single();
      if (error) throw error;
      const priorLevel = priorAccess?.permission_level;
      if (
        level === "view" &&
        (priorLevel === "prompt" || priorLevel === "admin")
      ) {
        await revokeAppMemberDeployKeysIfGitea(appId, memberId);
      }
      return mapAppAccessRow(data);
    },

    async removeAppAccess(appId: string, memberId: string) {
      const manager = await this.resolveAppAccessManager(appId);
      if (!manager) return null;
      const admin = await serviceRoleClient("manage app member access");
      const { error } = await admin
        .from("app_member_access")
        .delete()
        .eq("app_id", appId)
        .eq("member_id", memberId);
      if (error) throw error;
      await revokeAppMemberDeployKeysIfGitea(appId, memberId);
      return true;
    },

    async deleteApp(appId: string) {
      const { data: existing, error: selErr } = await supabase
        .from("apps")
        .select(
          "id, team_id, workspace_id, slug, name, fc_function_name, auth_mode, oauth_client_id, git_auth_kind, git_remote_url, created_by_actor_id",
        )
        .eq("id", appId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (!existing) return false;

      const permission = await this.resolveAppCallerPermissionForApp(existing);
      if (!permission || permission.level !== "admin") return false;

      const admin = await serviceRoleClient("delete app and archive workspace");
      const teardownInput = {
        appId,
        fcFunctionName: existing.fc_function_name,
        authMode: existing.auth_mode,
        oauthClientId: existing.oauth_client_id,
        gitAuthKind: existing.git_auth_kind,
        gitRemoteUrl: existing.git_remote_url,
      };
      const teardown: TeardownAppDeps = {
        ...(teardownDeps ?? {}),
        gotrue,
        gitea,
        deleteSecret: (kind) => deleteAppSecretSupabase(admin, appId, kind),
      };
      const { archivedRepoUrl } = await teardownAppResources(teardown, teardownInput);

      if (existing.workspace_id) {
        const now = new Date().toISOString();
        const { error: wsErr } = await admin
          .from("workspaces")
          .update({
            archived: true,
            path: archivedRepoUrl ?? existing.git_remote_url,
            updated_at: now,
          })
          .eq("id", existing.workspace_id);
        if (wsErr) throw wsErr;
        await archiveSessionsForWorkspace(admin, existing.workspace_id);
      }

      const { error: delErr } = await admin.from("apps").delete().eq("id", appId);
      if (delErr) throw delErr;
      return true;
    },

    // ─── Team skills registry ────────────────────────────────────────────────
    // docs/architecture/team-skills-registry.md
    //
    // Authz lives in RLS here (see 20260806000000_team_skills_registry.sql), so
    // these are thin. The pg-repo twin re-implements the same three install
    // gates in application code because that backend has no RLS to lean on —
    // when you change one, change the other.

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
      let alignedAny = false;
      for (const r of rows) {
        if (r.upstream_subscribed && r.origin === "marketplace") {
          if (await this._alignMarketplaceSkillRow(r)) alignedAny = true;
        }
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
      const slug = String(body.slug ?? "").trim();
      if (!TEAM_SKILL_SLUG_RE.test(slug)) {
        throw new ApiError(
          400,
          "validation_failed",
          "slug must be 2-64 chars of [a-z0-9-] and start with a letter or digit",
        );
      }
      const changelog = String(body.changelog ?? "").trim();
      if (!changelog) throw new ApiError(400, "validation_failed", "changelog is required");
      const contentHash = String(body.contentHash ?? "").trim();
      if (!contentHash) throw new ApiError(400, "validation_failed", "contentHash is required");

      const callerActorId = (await this.resolveCallerActorForTeam(teamId))?.id;
      if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");

      const { data, error } = await supabase
        .from("team_skills")
        .insert({
          team_id: teamId,
          slug,
          owner_actor_id: body.ownerActorId ?? callerActorId,
          summary: fields.summary,
          category: fields.category,
          when_to_use: fields.whenToUse,
          when_not_to_use: fields.whenNotToUse,
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
            `a skill named ${slug} already exists — publish a new version instead`,
          );
        }
        throw error;
      }

      const { error: vErr } = await supabase.from("team_skill_versions").insert({
        skill_id: data.id,
        version: 1,
        content_hash: contentHash,
        size: Number(body.size ?? 0),
        changelog,
        summary: fields.summary,
        category: fields.category,
        when_to_use: fields.whenToUse,
        when_not_to_use: fields.whenNotToUse,
        requires: fields.requires ?? null,
        created_by: callerActorId,
      });
      if (vErr) throw vErr;
      return mapTeamSkillRow(data);
    },

    async createTeamSkillVersion(teamId, slug, body: any = {}) {
      const changelog = String(body.changelog ?? "").trim();
      if (!changelog) throw new ApiError(400, "validation_failed", "changelog is required");
      const contentHash = String(body.contentHash ?? "").trim();
      if (!contentHash) throw new ApiError(400, "validation_failed", "contentHash is required");

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

      const patch = requireTeamSkillFields(body, { partial: true });

      const { data, error } = await supabase.rpc("publish_team_skill_version", {
        p_team_id: teamId,
        p_slug: slug,
        p_expected_latest_version: expectedLatestVersion,
        p_content_hash: contentHash,
        p_size: Number(body.size ?? 0),
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

    /** See the pg-repo twin for why a revert publishes forward instead of
     * moving latest_version back. */
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

    async updateTeamSkill(teamId, slug, patch: any = {}) {
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
      if (error) throw error;
      if (!data) throw new ApiError(404, "not_found", `skill not found: ${slug}`);
      return mapTeamSkillRow(data);
    },

    async deleteTeamSkill(teamId, slug) {
      const { error } = await supabase
        .from("team_skills")
        .delete()
        .eq("team_id", teamId)
        .eq("slug", slug);
      if (error) throw error;
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
      return { contentHash, size, ossKey };
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
     * message is a raw Postgres string — this turns them into the same answers
     * the pg-repo backend gives, so a client sees one behaviour regardless of
     * which backend is deployed.
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

    /**
     * Every actor carrying an install row for one skill.
     *
     * Only used to address the MQTT nudge after a publish — the reconcile is
     * still what decides anything. Returns ids and nothing else, since the
     * caller's entire job is to send "re-check now" to each of them.
     */
    async listTeamSkillInstallerActorIds(teamId, slug) {
      const { data: skillRows, error: skillErr } = await supabase
        .from("team_skills")
        .select("id")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .limit(1);
      if (skillErr) throw skillErr;
      const skillId = skillRows?.[0]?.id;
      if (!skillId) return [];

      const { data, error } = await supabase
        .from("team_skill_installs")
        .select("actor_id")
        .eq("team_id", teamId)
        .eq("skill_id", skillId);
      if (error) throw error;
      return (data ?? []).map((r: any) => r.actor_id).filter(Boolean);
    },

    ...makeSupabaseMarketplaceMethods({
      supabase,
      serviceRoleClient,
      mapTeamSkillRow,
      resolveCallerActorForTeam: async (teamId: string) => {
        const { data: userData, error: userErr } = await supabase.auth.getUser();
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
      },
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
      resolveCallerActorForTeam: async (teamId: string) => {
        const { data: userData, error: userErr } = await supabase.auth.getUser();
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
      },
    }),

    // ─── Team MCP catalog ────────────────────────────────────────────────────
    // docs/architecture/team-mcp-and-env-cloud.md
    //
    // Authz lives in RLS here (20260806020000_team_mcp_and_env.sql), so these
    // are thin. The *validation* is not authz and must not be left to RLS: the
    // secret-literal gate and the transport invariants are imported from the
    // pg-repo twin rather than restated, because two copies of a security rule
    // is exactly how one of them ends up weaker.

    // `actorId` defaults to the caller; passing another actor's id reads their
    // install state. Writes still refuse it — see the pg-repo twin for why the
    // read and the write are deliberately asymmetric.
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
// Validation is imported from the pg-repo twin rather than restated: these are
// security rules (what may hold a literal secret) and correctness rules (which
// transport needs which fields), and a second copy is how the two backends
// drift into disagreeing about what is allowed.

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

const TEAM_SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const TEAM_SKILL_CATEGORIES = [
  "general", "coding", "devops", "data",
  "research", "writing", "communication", "integration",
];

const TEAM_SKILL_STATUSES = ["draft", "published", "deprecated"];

/**
 * The publish gate: every one of these is required because the registry exists
 * to stop "who owns this / when to use it / when NOT to use it" from living in
 * one free-text description blob. Kept behaviourally identical to
 * pg-repo/team-skills.ts requirePublishFields.
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
  const optional = (key: string, value: unknown) => {
    if (value === undefined) return;
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
