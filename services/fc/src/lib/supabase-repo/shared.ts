// Shared helpers for the Supabase repository factories (business + auth),
// extracted from supabase-repo.ts so both can import them without a cycle.
import WebSocket from "ws";

import { ApiError } from "../http-utils.js";
import { appPublicUrl } from "../apps-public-host.js";

// FC runtime is Node 20 which lacks native WebSocket. supabase-js v2.45+ tries
// to construct a RealtimeClient at createClient() time and throws without a
// transport. We never use Realtime in FC; pass `ws` so the construction
// succeeds. The transport is only opened lazily when realtime channels are
// subscribed, which we never do.
export const REALTIME_TRANSPORT_OPTS = { transport: WebSocket };

export function requiredRow(data, operation) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new ApiError(502, "upstream_unavailable", `${operation} returned no row`);
  return row;
}

export function requiredString(value, operation, field) {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiError(502, "upstream_unavailable", `${operation} returned invalid ${field}`);
}

export function requiredInteger(value, operation, field) {
  if (Number.isInteger(value)) return value;
  throw new ApiError(502, "upstream_unavailable", `${operation} returned invalid ${field}`);
}

/**
 * Max ids per PostgREST `in.(…)` filter.
 *
 * PostgREST serialises `.in("id", ids)` into the GET query string: each uuid
 * costs 37 bytes (36 + comma). kong rejects request lines past its header
 * buffer (~8KB) with 414 — observed in production at 1296 ids / ~48KB, which
 * took the whole session list down.
 *
 * 100 keeps the filter near 3.7KB, leaving room for the base path and the
 * other filters that ride along on the same request.
 */
export const IN_FILTER_CHUNK_SIZE = 100;

/**
 * Run `fn` over `ids` in chunks small enough to survive the URL length limit,
 * concatenating the results.
 *
 * Chunks run sequentially: these calls are already on the request's critical
 * path and firing 13 concurrent PostgREST queries to render one list trades a
 * latency win for connection-pool pressure on the shared gateway.
 *
 * Callers keep their own empty-input guard — an empty `ids` here returns `[]`
 * without issuing a request, which is the correct answer for every current
 * caller but is NOT equivalent to "no filter".
 */
// Rows stay `any[]`: PostgREST's generics collapse to `unknown` through this
// indirection, and the callers in supabase-repo.ts are untyped throughout.
export async function chunkedIn(
  ids: readonly any[],
  fn: (chunk: any[]) => Promise<any[]>,
  chunkSize: number = IN_FILTER_CHUNK_SIZE,
): Promise<any[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  if (ids.length <= chunkSize) return fn(ids);

  const out: any[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    out.push(...(await fn(ids.slice(i, i + chunkSize))));
  }
  return out;
}

// ── Column constants + row mappers (moved from supabase-repo.ts) ──

export const DEFAULT_ATTACHMENT_BUCKET = "attachments";
export const TEAM_COLUMNS = "id, name, slug, created_at, visibility";
export const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";
export const WORKSPACE_COLUMNS =
  "id, team_id, name, path, agent_id, created_by_member_id, archived, created_at, updated_at";

// Translate the SQLSTATE codes raised by get/set_member_default_agent into the
// ApiError statuses rather than raw PostgREST errors.
// 42501 (insufficient privilege) -> 403; 23514 (check violation) -> 409;
// 23503 (foreign-key/not-found) -> 404. Anything else propagates unchanged.
export function mapDefaultAgentError(error: any) {
  switch (error?.code) {
    case "42501":
      return new ApiError(403, "forbidden", error.message ?? "forbidden");
    case "23514":
      return new ApiError(409, "invalid_agent", error.message ?? "invalid agent");
    case "23503":
      return new ApiError(404, "not_found", error.message ?? "not found");
    default:
      return error;
  }
}


// --- Apps helpers ---

// `org_id` is selected but intentionally NOT mapped: it is the server's
// deployment ledger (which database the schema was created in), not part of
// the client contract. Selecting it keeps finalizeDeploy and the data browser
// from needing a second round trip.
export const APP_COLUMNS =
  "id, team_id, org_id, name, slug, type, visibility, workspace_id, git_remote_url, git_auth_kind, git_commit_sha, runtime, auth_mode, deployed_auth_mode, oauth_client_id, provision_status, fc_status, fc_endpoint, fc_function_name, fc_region, created_at, updated_at";

export function slugify(name: string): string {
  return (
    String(name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

export const appIso = (v: any): string | null => (v ? new Date(v).toISOString() : null);

// Exposes EXACTLY the canonical app fields. Reads snake_case DB columns
// (PostgREST returns the table's native column names).
export function mapApp(r: any) {
  return {
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    slug: r.slug,
    type: r.type,
    visibility: r.visibility,
    workspaceId: r.workspace_id ?? null,
    gitRemoteUrl: r.git_remote_url ?? null,
    // `gitea_deploy_key` marks an app whose repo this deployment provisioned
    // and holds a credential for; null marks one imported from a remote we have
    // no access to. The client needs the distinction to know whether deploy can
    // go through Gitea at all.
    gitAuthKind: r.git_auth_kind ?? null,
    gitCommitSha: r.git_commit_sha ?? null,
    runtime: r.runtime ?? "node",
    authMode: r.auth_mode ?? "none",
    // Derived here, not in the client, so every client agrees on the rule.
    //
    // The OAuth env is baked in at finalizeDeploy, so an authMode change does
    // nothing to the running function until the next deploy. Saying so is a
    // security requirement (design §7.4): a user who just switched an app to
    // "requires login" would otherwise believe it is already protected while
    // the site is still fully public. `deployed_auth_mode` is NULL on rows that
    // predate the column, and NULL only matters once something is live.
    authModePendingRedeploy:
      r.fc_status === "live" &&
      (r.deployed_auth_mode ?? null) !== null &&
      (r.deployed_auth_mode ?? "none") !== (r.auth_mode ?? "none"),
    // Public client id only — never the secret (stored in app_secrets).
    oauthClientId: r.oauth_client_id ?? null,
    provisionStatus: r.provision_status,
    fcStatus: r.fc_status ?? null,
    fcEndpoint: r.fc_endpoint ?? null,
    // Derived, never stored: the vanity host is a pure function of slug + id,
    // and a deployment without an apps domain has none. Storing it would let a
    // renamed app keep a hostname that no longer routes.
    publicUrl: appPublicUrl(r.slug, r.id),
    fcFunctionName: r.fc_function_name ?? null,
    fcRegion: r.fc_region ?? null,
    createdAt: appIso(r.created_at)!,
    updatedAt: appIso(r.updated_at)!,
  };
}

export const SESSION_FULL_COLUMNS =
  "id, team_id, title, mode, idea_id, primary_agent_id, created_by_actor_id, summary, last_message_preview, last_message_at, acp_session_id, binding, gateway_key, source, cron_job_id, parent_session_id, thread_root_message_id, created_at, updated_at";

// `source` / `source_id` identify the gateway an EXTERNAL actor came in through
// (wecom / wechat / feishu / discord / kook / seatalk / email + the id in that
// system). Null for members and agents. Added to the actor_directory view by
// 20260818000000_actor_directory_external_source.sql — deploying this FC against
// a database that predates that migration makes PostgREST reject the select.
export const ACTOR_DIRECTORY_COLUMNS =
  "id, team_id, actor_type, user_id, invited_by_actor_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, agent_visibility, owner_member_id, last_active_at, created_at, updated_at, user_email, user_phone, source, source_id";

export function mapSessionFull(row) {
  return {
    id: row?.id,
    teamId: row?.team_id ?? null,
    title: row?.title ?? "",
    mode: row?.mode ?? "solo",
    ideaId: row?.idea_id ?? null,
    primaryAgentId: row?.primary_agent_id ?? null,
    createdByActorId: row?.created_by_actor_id ?? null,
    summary: row?.summary ?? null,
    lastMessageAt: row?.last_message_at ?? null,
    lastMessagePreview: row?.last_message_preview ?? null,
    hasUnread: false,
    acpSessionId: row?.acp_session_id ?? null,
    binding: row?.binding ?? null,
    // The chat a session belongs to for its whole life. `binding` is released
    // when `/new` moves the chat on, so it answers "is this the current one",
    // not "which chat is this". Without the distinction a detached session
    // cannot say where it came from, and `/sessions` asked from one listed
    // nothing at all.
    gatewayKey: row?.gateway_key ?? null,
    source: row?.source ?? "user",
    cronJobId: row?.cron_job_id ?? null,
    parentSessionId: row?.parent_session_id ?? null,
    threadRootMessageId: row?.thread_root_message_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapDirectoryActor(row) {
  return {
    id: row?.id,
    teamId: row?.team_id ?? null,
    kind: row?.actor_type ?? null,
    displayName: row?.display_name ?? null,
    avatarUrl: row?.avatar_url ?? null,
    userId: row?.user_id ?? null,
    invitedByActorId: row?.invited_by_actor_id ?? null,
    teamRole: row?.team_role ?? null,
    memberStatus: row?.member_status ?? null,
    agentStatus: row?.agent_status ?? null,
    agentTypes: row?.agent_types ?? null,
    agentKind: null,
    defaultAgentType: row?.default_agent_type ?? null,
    defaultWorkspaceId: row?.default_workspace_id ?? null,
    visibility: row?.agent_visibility ?? null,
    agentOwnerMemberId: row?.owner_member_id ?? null,
    lastActiveAt: row?.last_active_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
    // Member contact (null for agents/external and for anonymous accounts that
    // never set an email/phone). Surfaced via the actor_directory view's
    // SECURITY DEFINER contact join — only teammates ever receive these.
    email: row?.user_email ?? null,
    phone: row?.user_phone ?? null,
    // External actors only: which gateway they came in through, and their id in
    // that system. The actors CHECK constraint keeps these two null for every
    // member and agent.
    source: row?.source ?? null,
    sourceId: row?.source_id ?? null,
  };
}

export function publishableKeyFromEnv(env = process.env) {
  return env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
}

export function outgoingMessageRow(sessionId, input) {
  const row: any = {
    id: input.id,
    team_id: input.teamId,
    session_id: sessionId,
    sender_actor_id: input.senderActorId,
    kind: input.kind ?? "text",
    content: input.content,
    // Column is `jsonb not null default '{}'`. An explicit NULL bypasses the
    // default and trips the not-null constraint, so default to {} here (mirrors
    // iOS sends no metadata when a message has no mentions.
    metadata: input.metadata ?? {},
    model: input.model ?? null,
    turn_id: input.turnId ?? null,
    reply_to_message_id: input.replyToMessageId ?? null,
  };
  if (input.createdAt) row.created_at = input.createdAt;
  return row;
}

export function mapTeam(row) {
  return {
    id: requiredString(row?.id, "teams.mapTeam", "id"),
    name: requiredString(row?.name, "teams.mapTeam", "name"),
    slug: row?.slug ?? null,
    createdAt: row?.created_at ?? null,
    orgId: row?.oid ?? null,
    orgName: (row?.orgs as any)?.name ?? null,
    visibility: row?.visibility ?? "private",
  };
}

export function mapSession(row) {
  return {
    id: requiredString(row?.id, "sessions.mapSession", "id"),
    teamId: requiredString(row?.team_id, "sessions.mapSession", "team_id"),
    title: row?.title ?? "",
    mode: row?.mode ?? "solo",
    ideaId: row?.idea_id ?? null,
    lastMessageAt: row?.last_message_at ?? null,
    lastMessagePreview: row?.last_message_preview ?? null,
    hasUnread: row?.has_unread === true,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
    // Origin marker. List rows come from the list_current_actor_sessions RPC,
    // which only started returning these in 20260727000000 — default to 'user'
    // so a stale database still yields the pre-cron-filter behaviour instead of
    // an undefined that the client would read as "unknown origin".
    source: row?.source ?? "user",
    cronJobId: row?.cron_job_id ?? null,
    // Display-row fields. These moved onto the list RPC in 20260802000000 when
    // GET /v1/teams/:teamId/sessions (their previous home) was removed; a
    // database that predates that migration simply omits them, so default
    // rather than assume.
    summary: row?.summary ?? null,
    primaryAgentId: row?.primary_agent_id ?? null,
    createdByActorId: row?.created_by_actor_id ?? null,
    participantCount: Number(row?.participant_count ?? 0),
  };
}

export function mapMessage(row) {
  return {
    id: requiredString(row?.id, "messages.mapMessage", "id"),
    teamId: requiredString(row?.team_id, "messages.mapMessage", "team_id"),
    sessionId: requiredString(row?.session_id, "messages.mapMessage", "session_id"),
    turnId: row?.turn_id ?? null,
    senderActorId: row?.sender_actor_id ?? null,
    replyToMessageId: row?.reply_to_message_id ?? null,
    kind: row?.kind ?? "text",
    content: row?.content ?? "",
    metadata: row?.metadata ?? null,
    model: row?.model ?? null,
    createdAt: requiredString(row?.created_at, "messages.mapMessage", "created_at"),
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapWorkspace(row) {
  const path = row?.path ?? null;
  return {
    id: requiredString(row?.id, "workspaces.mapWorkspace", "id"),
    teamId: requiredString(row?.team_id, "workspaces.mapWorkspace", "team_id"),
    name: requiredString(row?.name, "workspaces.mapWorkspace", "name"),
    path,
    slug: path,
    agentId: row?.agent_id ?? null,
    createdByMemberId: row?.created_by_member_id ?? null,
    archived: row?.archived === true,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapShortcut(row) {
  return mapShortcutRow(row);
}

export function mapTeamRole(row) {
  return {
    id: requiredString(row?.id, "roles.mapTeamRole", "id"),
    teamId: requiredString(row?.team_id, "roles.mapTeamRole", "team_id"),
    code: requiredString(row?.code, "roles.mapTeamRole", "code"),
    name: requiredString(row?.name, "roles.mapTeamRole", "name"),
  };
}

export function mapPermission(row) {
  return {
    resourceId: requiredString(row?.resource_id, "permissions.mapPermission", "resource_id"),
    roleIds: (row?.permission_roles ?? []).map((x) => requiredString(x?.role_id, "permissions.mapPermission", "role_id")),
  };
}

export function mapActor(row) {
  return {
    id: requiredString(row?.id, "actors.mapActor", "id"),
    teamId: requiredString(row?.team_id, "actors.mapActor", "team_id"),
    kind: row?.kind ?? "user",
    displayName: row?.display_name ?? "",
    avatarUrl: row?.avatar_url ?? null,
    metadata: row?.metadata ?? null,
  };
}

export function mapTeamMember(row) {
  return {
    actorId: requiredString(row?.actor_id, "teamMembers.mapTeamMember", "actor_id"),
    teamId: requiredString(row?.team_id, "teamMembers.mapTeamMember", "team_id"),
    role: row?.role ?? "member",
    joinedAt: row?.joined_at ?? null,
  };
}

export function mapIdeaRow(row) {
  return {
    id: requiredString(row?.id, "ideas.mapIdeaRow", "id"),
    teamId: requiredString(row?.team_id, "ideas.mapIdeaRow", "team_id"),
    title: requiredString(row?.title, "ideas.mapIdeaRow", "title"),
    description: row?.description ?? null,
    archived: row?.archived === true,
    authorActorId: row?.author_actor_id ?? null,
    actorIds: row?.actor_ids ?? [],
    // Fields the ideas table carries that clients (iOS IdeaStore) depend on.
    workspaceId: row?.workspace_id ?? null,
    status: row?.status ?? null,
    sortOrder: row?.sort_order ?? 0,
    createdByActorId: row?.created_by_actor_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapShortcutRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    scope: row.scope,
    label: row.label,
    owner_member_id: row.owner_member_id ?? null,
    team_id: row.team_id ?? null,
    parent_id: row.parent_id ?? null,
    icon: row.icon ?? null,
    order: row.order ?? 0,
    node_type: row.node_type,
    target: row.target ?? "",
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}


export function mapIdeaActivityRow(row) {
  const kind = row?.kind ?? row?.activity_type;
  return {
    id: requiredString(row?.id, "ideas.mapIdeaActivityRow", "id"),
    ideaId: requiredString(row?.idea_id, "ideas.mapIdeaActivityRow", "idea_id"),
    kind: requiredString(kind, "ideas.mapIdeaActivityRow", "kind"),
    // Expose `activityType` alongside `kind` for clients that key on it.
    activityType: kind,
    content: row?.content ?? null,
    actorId: requiredString(row?.actor_id, "ideas.mapIdeaActivityRow", "actor_id"),
    metadata: row?.metadata ?? null,
    teamId: row?.team_id ?? null,
    attachmentUrls: row?.attachment_urls ?? [],
    createdAt: requiredString(row?.created_at, "ideas.mapIdeaActivityRow", "created_at"),
    updatedAt: row?.updated_at ?? null,
  };
}

export function mapFeedbackRow(row) {
  return {
    messageId: requiredString(row?.message_id, "feedback.mapFeedbackRow", "message_id"),
    actorId: requiredString(row?.actor_id, "feedback.mapFeedbackRow", "actor_id"),
    teamId: row?.team_id ?? null,
    sessionId: row?.session_id ?? null,
    kind: requiredString(row?.kind, "feedback.mapFeedbackRow", "kind"),
    starRating: row?.star_rating ?? null,
    skill: row?.skill ?? null,
    createdAt: row?.created_at ?? null,
  };
}

export function mapLeaderboardRow(row) {
  return {
    actorId: requiredString(row?.actor_id, "leaderboard.mapLeaderboardRow", "actor_id"),
    teamId: row?.team_id ?? null,
    displayName: row?.display_name ?? null,
    period: requiredString(row?.period, "leaderboard.mapLeaderboardRow", "period"),
    tokensUsed: Number(row?.tokens_used ?? 0),
    costUsd: Number(row?.cost_usd ?? 0),
    positiveFeedback: Number(row?.positive_feedback ?? 0),
    negativeFeedback: Number(row?.negative_feedback ?? 0),
    sessionCount: Number(row?.session_count ?? 0),
    skillUsage: row?.skill_usage ?? {},
    score: Number(row?.score ?? 0),
  };
}
